import Link from "next/link";
import { requireBusiness } from "@/lib/auth";
import { SocialConnections } from "@/components/social-connections";
export default async function SocialConnectPage({ searchParams }: { searchParams: Promise<{ business?: string; failed?: string }> }) {
  const query = await searchParams;
  let business: { id: string; name: string } | null = null;
  if (typeof query.business === "string") { try { business = (await requireBusiness(query.business)).business; } catch { /* Do not reveal another business. */ } }
  return <main className="connection-return"><div>
    <p className="eyebrow">PUBLISHING DESTINATIONS</p><h1>{business ? `Connect an account for ${business.name}` : "Connection not completed"}</h1>
    {business ? <SocialConnections businessId={business.id} /> : <p>Return to your studio, sign in if needed, and start a new connection from the correct business. No account was connected by this response.</p>}
    <Link href="/studio">Return to your studio</Link>
  </div></main>;
}
