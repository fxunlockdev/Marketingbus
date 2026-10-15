import { redirect } from "next/navigation";
import { session } from "@/lib/auth";
import { db } from "@/lib/db";
import { Studio } from "@/components/studio";
import { planItemSelection, planSummarySelection } from "@/lib/production/history";
export const dynamic="force-dynamic";
export default async function StudioPage(){
  const user=await session();if(!user)redirect("/login");
  const orgIds=user.memberships.map(m=>m.organizationId);
  const businesses=await db.business.findMany({where:{organizationId:{in:orgIds}},orderBy:{createdAt:"asc"},include:{memories:{orderBy:{createdAt:"desc"}},plans:{where:{status:"PROPOSED"},take:1,select:{...planSummarySelection,items:{orderBy:{id:"asc"},take:100,select:planItemSelection}},orderBy:[{createdAt:"desc"},{id:"desc"}]},auditEvents:{orderBy:{createdAt:"desc"},take:12}}});
  const wallets=await db.wallet.findMany({where:{organizationId:{in:orgIds}}});
  return <Studio user={{name:user.name,email:user.email}} initialBusinesses={JSON.parse(JSON.stringify(businesses.map(b=>({...b,canEdit:user.memberships.some(m=>m.organizationId===b.organizationId&&["OWNER","ADMIN","EDITOR"].includes(m.role))}))))} wallets={wallets.map(w=>({organizationId:w.organizationId,available:w.available,held:w.held}))}/>;
}
