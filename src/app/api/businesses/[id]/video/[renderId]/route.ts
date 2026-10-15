import { z } from "zod";
import { requireBusiness, rateLimit } from "@/lib/auth";
import { api } from "@/lib/http";
import { readMotion, motionMetadata } from "@/lib/video/service";
import { subtitleVtt } from "@/lib/video/document";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string; renderId: string }> }) {
  try {
    const { id, renderId } = await context.params, { user, business } = await requireBusiness(id);
    await rateLimit("video:read", user.id, 30);
    const query = z.object({ download: z.enum(["true", "false"]).default("false"), format: z.enum(["mp4", "vtt", "json"]).default("mp4") }).strict().parse(Object.fromEntries(new URL(request.url).searchParams));
    const scope = { businessId: id, organizationId: business.organizationId, actorId: user.id };
    const body = query.format === "mp4" ? (await readMotion(scope, renderId, query.download === "true")).bytes : await motionMetadata(scope, renderId, true).then(result => Buffer.from(query.format === "vtt" ? subtitleVtt(result.document) : JSON.stringify(result.document, null, 2)));
    return new Response(new Uint8Array(body), { headers: { "Content-Type": { mp4: "video/mp4", vtt: "text/vtt; charset=utf-8", json: "application/json" }[query.format], "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `${query.download === "true" || query.format !== "mp4" ? "attachment" : "inline"}; filename=motion-reel.${query.format}` } });
  } catch (error) { return api(async () => { throw error; }); }
}
