import { db } from "../db";
import { AppError } from "../http";
import type { Prisma } from "@prisma/client";
function amount(value:number){if(!Number.isSafeInteger(value)||value<=0)throw new AppError(400,"Credits must be a positive integer.");}
// Internal services only. No public credit-grant route; verified payment events are still a release dependency.
export async function reserveCredits(organizationId:string,operationId:string,credits:number,revision=false){
 return db.$transaction(tx=>reserveCreditsInTransaction(tx,organizationId,operationId,credits,revision));
}
export async function reserveCreditsInTransaction(tx:Prisma.TransactionClient,organizationId:string,operationId:string,credits:number,revision=false){
 amount(credits);const key=`${organizationId}:${operationId}`, purpose=revision?"REVISION":"INITIAL";
  await tx.$queryRaw`SELECT "organizationId" FROM "Wallet" WHERE "organizationId"=${organizationId} FOR UPDATE`;
  const previous=await tx.reservation.findUnique({where:{key}});
  if(previous){if(previous.credits!==credits||previous.purpose!==purpose)throw new AppError(409,"Reservation replay changed the amount or purpose.");return previous;}
  const wallet=await tx.wallet.findUnique({where:{organizationId}});
  if(!wallet||wallet.debt||wallet.revisionDebt)throw new AppError(409,"Credit balance is unavailable or has an outstanding refund adjustment.");
  const revisionCredits=revision?Math.min(wallet.revisionAvailable,credits):0;
  if(wallet.available<credits-revisionCredits)throw new AppError(409,"Insufficient credits.");
  await tx.wallet.update({where:{organizationId},data:{available:{decrement:credits-revisionCredits},revisionAvailable:{decrement:revisionCredits},held:{increment:credits}}});
  await tx.creditEntry.create({data:{organizationId,key:`reserve:${key}`,kind:"RESERVE",amount:credits}});
  return tx.reservation.create({data:{organizationId,key,credits,revisionCredits,purpose}});
}
// Caller holds the wallet row lock. Returned credits and new grants first pay refund debt.
export async function addCreditsInTransaction(tx:Prisma.TransactionClient,organizationId:string,general:number,revision:number){
 if(!Number.isSafeInteger(general)||general<0||!Number.isSafeInteger(revision)||revision<0)throw new AppError(400,"Invalid credit allocation.");
 const wallet=await tx.wallet.findUniqueOrThrow({where:{organizationId}}), payGeneral=Math.min(wallet.debt,general),payRevision=Math.min(wallet.revisionDebt,revision);
 await tx.wallet.update({where:{organizationId},data:{available:{increment:general-payGeneral},revisionAvailable:{increment:revision-payRevision},debt:{decrement:payGeneral},revisionDebt:{decrement:payRevision}}});
}
export async function finishReservation(organizationId:string,id:string,consumed:number){
 return db.$transaction(tx=>finishReservationInTransaction(tx,organizationId,id,consumed));
}
export async function finishReservationInTransaction(tx:Prisma.TransactionClient,organizationId:string,id:string,consumed:number){
 if(!Number.isSafeInteger(consumed)||consumed<0)throw new AppError(400,"Invalid settlement.");
  await tx.$queryRaw`SELECT "organizationId" FROM "Wallet" WHERE "organizationId"=${organizationId} FOR UPDATE`;
  const reservation=await tx.reservation.findFirst({where:{id,organizationId}});
  if(!reservation)throw new AppError(404,"Reservation not found.");
  if(reservation.state!=="HELD"){
   const previous=await tx.creditEntry.findUnique({where:{key:`settle:${reservation.key}`}});
   if(previous?.amount!==consumed)throw new AppError(409,"Settlement replay changed the amount.");
   return reservation;
  }
  if(consumed>reservation.credits)throw new AppError(409,"Settlement exceeds the accepted quote.");
  const usedRevision=Math.min(consumed,reservation.revisionCredits);
  await tx.wallet.update({where:{organizationId},data:{held:{decrement:reservation.credits}}});
  await addCreditsInTransaction(tx,organizationId,reservation.credits-reservation.revisionCredits-(consumed-usedRevision),reservation.revisionCredits-usedRevision);
  await tx.creditEntry.create({data:{organizationId,key:`settle:${reservation.key}`,kind:"CONSUME",amount:consumed}});
  if(consumed<reservation.credits)await tx.creditEntry.create({data:{organizationId,key:`release:${reservation.key}`,kind:"RELEASE",amount:reservation.credits-consumed}});
  return tx.reservation.update({where:{id},data:{state:consumed?"SETTLED":"RELEASED"}});
}
