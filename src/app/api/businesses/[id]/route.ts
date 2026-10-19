import { z } from "zod";
import { db } from "@/lib/db";
import { requireBusiness, rateLimit } from "@/lib/auth";
import { api, readBody, AppError } from "@/lib/http";
import { brandInput, proposePlan } from "@/lib/brand";
import { replaceBrandProfile } from "@/lib/knowledge/profile";
import { assertBrandEditor } from "@/lib/knowledge/analysis";
const updateInput=z.discriminatedUnion("action",[
  z.object({action:z.literal("update"),version:z.number().int().positive(),profile:brandInput}).strict(),
  z.object({action:z.literal("confirm"),version:z.number().int().positive()}).strict(),
  z.object({action:z.literal("plan"),version:z.number().int().positive()}).strict(),
  z.object({action:z.literal("memory"),text:z.string().trim().min(3).max(1000)}).strict(),
  z.object({action:z.literal("forget"),memoryId:z.string().min(1)}).strict()
]);
export async function POST(request:Request, context:{params:Promise<{id:string}>}) {
  return api(async()=>{
    const {id}=await context.params; const {user,business}=await requireBusiness(id,true);
    const input=updateInput.parse(await readBody(request));
    await rateLimit("business:write",user.id,120);
    return db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Business" WHERE id=${id} FOR UPDATE`;
      await assertBrandEditor(tx,{businessId:id,organizationId:business.organizationId,actorId:user.id});
      const fresh=await tx.business.findUniqueOrThrow({where:{id}});
      if("version" in input && fresh.version!==input.version) throw new AppError(409,"This profile changed. Refresh before saving.");
      const audit=(action:string,detail:string)=>tx.auditEvent.create({data:{businessId:id,organizationId:business.organizationId,actorId:user.id,action,detail}});
      if(input.action==="update") {
        await replaceBrandProfile(tx,{businessId:id,organizationId:business.organizationId,actorId:user.id},input.profile);
        await audit("PROFILE_UPDATED","Profile changed; confirmation and production authorization reset.");
      }
      if(input.action==="confirm") {
        if(fresh.setupStep !== null && fresh.setupStep < 6) throw new AppError(409,"Finish the guided business setup before confirming this profile.");
        brandInput.parse(Object.fromEntries(Object.keys(brandInput.shape).map(key=>[key,fresh[key as keyof typeof fresh]])));
        await tx.brandSnapshot.upsert({where:{businessId_version:{businessId:id,version:fresh.version}},create:{businessId:id,organizationId:business.organizationId,version:fresh.version,data:JSON.parse(JSON.stringify(fresh))},update:{}});
        await tx.business.update({where:{id},data:{confirmedAt:new Date()}});
        await audit("PROFILE_CONFIRMED",`Confirmed brand version ${fresh.version}.`);
      }
      if(input.action==="plan") {
        if(!fresh.confirmedAt) throw new AppError(409,"Confirm the business profile before planning.");
        const existing=await tx.productionPlan.findFirst({where:{businessId:id,brandVersion:fresh.version,status:"PROPOSED"}});
        if(existing) return {ok:true,id:existing.id};
        const profile=brandInput.parse(Object.fromEntries(Object.keys(brandInput.shape).map(key=>[key,fresh[key as keyof typeof fresh]])));
        const plan=await tx.productionPlan.create({data:{businessId:id,organizationId:business.organizationId,brandVersion:fresh.version,title:"Your first content direction",creditCeiling:0,items:{create:proposePlan(profile)}}});
        await audit("PLAN_PROPOSED","Created a profile-based planning outline. No AI generation or credits consumed.");
        return {ok:true,id:plan.id};
      }
      if(input.action==="memory") {
        await tx.generationQuote.updateMany({where:{businessId:id,status:"OFFERED"},data:{status:"SUPERSEDED"}});
        if(await tx.memory.count({where:{businessId:id}})>=100) throw new AppError(409,"Remove unused preferences before adding more.");
        await tx.memory.create({data:{businessId:id,organizationId:business.organizationId,text:input.text}});
        await audit("PREFERENCE_SAVED","An explicit brand preference was saved.");
      }
      if(input.action==="forget") {
        await tx.generationQuote.updateMany({where:{businessId:id,status:"OFFERED"},data:{status:"SUPERSEDED"}});
        await tx.memory.deleteMany({where:{id:input.memoryId,businessId:id,organizationId:business.organizationId}});
        await audit("PREFERENCE_REMOVED","A brand preference was removed.");
      }
      return {ok:true};
    });
  });
}
