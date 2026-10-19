import { mediaDeliveryHeaders, readInstagramMediaDelivery } from "@/lib/social/instagram-delivery";
import { reelRange } from "@/lib/social/instagram-video";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ publicationId: string; token: string }> }) {
  try {
    const { publicationId, token } = await context.params;
    const media = await readInstagramMediaDelivery(publicationId, token), bytes = media.bytes!;
    const headers = { ...mediaDeliveryHeaders, "Content-Type": media.contentType, ...(media.contentType === "video/mp4" ? { "Accept-Ranges": "bytes" } : {}) };
    if (media.contentType === "video/mp4") {
      let range;
      try { range = reelRange(request.headers.get("range"), bytes.length); }
      catch { return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${bytes.length}` } }); }
      if (range) return new Response(new Uint8Array(bytes.subarray(range.start, range.end + 1)), { status: 206, headers: { ...headers, "Content-Length": String(range.end - range.start + 1), "Content-Range": `bytes ${range.start}-${range.end}/${bytes.length}` } });
    }
    return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Length": String(bytes.length) } });
  } catch { return new Response(null, { status: 404, headers: mediaDeliveryHeaders }); }
}
// Explicit, authenticated and read-limited metadata; never load or convert video for HEAD.
export async function HEAD(_request: Request, context: { params: Promise<{ publicationId: string; token: string }> }) {
  try {
    const { publicationId, token } = await context.params, media = await readInstagramMediaDelivery(publicationId, token, undefined, true);
    return new Response(null, { headers: { ...mediaDeliveryHeaders, "Content-Type": media.contentType, "Content-Length": String(media.length), "Accept-Ranges": "bytes" } });
  } catch { return new Response(null, { status: 404, headers: mediaDeliveryHeaders }); }
}
export function POST() { return new Response(null, { status: 405, headers: { ...mediaDeliveryHeaders, Allow: "GET, HEAD" } }); }
