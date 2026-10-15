import { afterAll,describe,it,expect } from "vitest";
import { db } from "../src/lib/db";
import { reserveCredits,finishReservation } from "../src/lib/billing/wallet";
const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
if (process.env.TEST_DATABASE_URL) {
 const target = new URL(process.env.TEST_DATABASE_URL);
 if (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["127.0.0.1", "localhost"].includes(target.hostname)) {
  throw new Error("Wallet integration tests require matching, explicitly local database URLs.");
 }
}
suite("PostgreSQL reservation safety",()=>{
 const ids:string[]=[];
 afterAll(async()=>{if(ids.length)await db.organization.deleteMany({where:{id:{in:ids}}});await db.$disconnect();});
 async function org(){const result=await db.organization.create({data:{name:"WALLET TEST ONLY",wallet:{create:{available:100}}}});ids.push(result.id);return result.id;}
 it("concurrent jobs cannot overspend",async()=>{const id=await org();const outcomes=await Promise.allSettled(Array.from({length:10},(_,i)=>reserveCredits(id,`job-${i}`,30)));expect(outcomes.filter(o=>o.status==="fulfilled")).toHaveLength(3);const wallet=await db.wallet.findUniqueOrThrow({where:{organizationId:id}});expect(wallet.available).toBe(10);expect(wallet.held).toBe(90);});
 it("replay reserves once and settlement releases unused credits",async()=>{const id=await org();const [a,b]=await Promise.all([reserveCredits(id,"one",40),reserveCredits(id,"one",40)]);expect(a.id).toBe(b.id);await finishReservation(id,a.id,25);await finishReservation(id,a.id,25);const wallet=await db.wallet.findUniqueOrThrow({where:{organizationId:id}});expect(wallet.available).toBe(75);expect(wallet.held).toBe(0);await expect(finishReservation(id,a.id,30)).rejects.toThrow("changed");});
 it("other organizations cannot settle a reservation",async()=>{const owner=await org(),other=await org();const r=await reserveCredits(owner,"scope",20);await expect(finishReservation(other,r.id,20)).rejects.toThrow("not found");});
});
