import { db } from "@/lib/db";
import { requireUser, rateLimit } from "@/lib/auth";
import { api, readBody, AppError } from "@/lib/http";
import { brandInput } from "@/lib/brand";
export async function POST(request:Request) {
  return api(async()=>{
    const user=await requireUser(); const input=brandInput.parse(await readBody(request));
    const membership=user.memberships.find(m=>["OWNER","ADMIN"].includes(m.role));
    if(!membership) throw new AppError(403,"Only a workspace owner can create businesses.");
    await rateLimit("business:create",user.id,10);
    const business=await db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${membership.organizationId} FOR UPDATE`;
      if(await tx.business.count({where:{organizationId:membership.organizationId}})>=3) throw new AppError(409,"This pilot supports up to three businesses per organization.");
      return tx.business.create({data:{...input,organizationId:membership.organizationId}});
    });
    return {id:business.id};
  });
}
