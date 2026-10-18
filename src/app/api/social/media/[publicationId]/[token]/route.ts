import { mediaDeliveryHeaders, readInstagramDelivery } from "@/lib/social/instagram-delivery";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ publicationId: string; token: string }> }) {
  try {
    const { publicationId, token } = await context.params;
    const bytes = await readInstagramDelivery(publicationId, token);
    return new Response(new Uint8Array(bytes), { headers: { ...mediaDeliveryHeaders, "Content-Type": "image/jpeg", "Content-Length": String(bytes.length) } });
  } catch { return new Response(null, { status: 404, headers: mediaDeliveryHeaders }); }
}
// Do not let implicit HEAD execute a conversion or consume a delivery allowance.
export function HEAD() { return new Response(null, { status: 404, headers: mediaDeliveryHeaders }); }
export function POST() { return new Response(null, { status: 405, headers: { ...mediaDeliveryHeaders, Allow: "GET" } }); }
