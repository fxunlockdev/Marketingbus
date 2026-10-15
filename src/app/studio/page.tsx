import { redirect } from "next/navigation";
import { session } from "@/lib/auth";
import { db } from "@/lib/db";
import { Studio } from "@/components/studio";
export const dynamic="force-dynamic";
export default async function StudioPage(){
  const user=await session();if(!user)redirect("/login");
  const orgIds=user.memberships.map(m=>m.organizationId);
  const businesses=await db.business.findMany({where:{organizationId:{in:orgIds}},orderBy:{createdAt:"asc"},include:{memories:{orderBy:{createdAt:"desc"}},plans:{where:{status:"PROPOSED"},include:{items:{include:{revisions:{orderBy:{version:"desc"},take:1,select:{id:true,version:true,content:true,status:true,feedback:true}},schedule:true,quotes:{orderBy:{createdAt:"desc"},take:3,select:{id:true,credits:true,status:true,expiresAt:true,job:{select:{status:true,errorCode:true}}}}}}},orderBy:{createdAt:"desc"}},auditEvents:{orderBy:{createdAt:"desc"},take:12}}});
  const wallets=await db.wallet.findMany({where:{organizationId:{in:orgIds}}});
  return <Studio user={{name:user.name,email:user.email}} initialBusinesses={JSON.parse(JSON.stringify(businesses))} wallets={wallets.map(w=>({organizationId:w.organizationId,available:w.available,held:w.held}))}/>;
}
