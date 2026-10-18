import { z } from "zod";
import { api, readBody } from "@/lib/http";
import { requireBusiness, rateLimit } from "@/lib/auth";
import { readClip, reviewClip, recoverClipStorage } from "@/lib/video/clips";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; clipId: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    const { id, clipId } = await context.params, { user, business } = await requireBusiness(id); await rateLimit("audio:preview", user.id, 30);
    const bytes = await readClip({ businessId: id, organizationId: business.organizationId, actorId: user.id }, clipId, undefined, "AUDIO");
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "audio/wav", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline; filename=review-music.wav" } });
  } catch (e) { return api(async () => { throw e; }); }
}
export async function POST(request: Request, context: Context) {
  return api(async () => {
    const { id, clipId } = await context.params, { user, business } = await requireBusiness(id, true), body = await readBody(request); await rateLimit("audio:review", user.id, 60);
    const scope = { businessId: id, organizationId: business.organizationId, actorId: user.id };
    if ((body as { action?: string })?.action === "recover") { z.object({ action: z.literal("recover") }).strict().parse(body); return recoverClipStorage(scope, clipId, undefined, "AUDIO"); }
    return reviewClip(scope, clipId, body, "AUDIO");
  });
}
