import { z } from "zod";
import { requireBusiness, rateLimit } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { listVideo, manageVideo } from "@/lib/video/service";
import { recoverMotionStorage } from "@/lib/video/worker";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => { const { id } = await context.params, { user, business } = await requireBusiness(id); return listVideo({ businessId: id, organizationId: business.organizationId, actorId: user.id }); });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id, true), input = await readBody(request);
    await rateLimit("video:write", user.id, 60);
    const scope = { businessId: id, organizationId: business.organizationId, actorId: user.id };
    if ((input as { action?: string })?.action === "recover-render") {
      const parsed = z.object({ action: z.literal("recover-render"), renderId: z.string().min(1) }).strict().parse(input);
      return recoverMotionStorage(scope, parsed.renderId);
    }
    return manageVideo(scope, input);
  });
}
