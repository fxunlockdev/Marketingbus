import { z } from "zod";
import { requireBusiness, rateLimit } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { archiveCompositionExport, listCompositionExports, reconcileCompositionExport, saveCompositionExport } from "@/lib/composition/exports";
const actions = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), compositionId: z.string().min(1), placement: z.enum(["square", "portrait", "story", "landscape"]) }).strict(),
  z.object({ action: z.enum(["archive", "reconcile"]), exportId: z.string().min(1) }).strict(),
]);
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id);
    await rateLimit("exports:read", user.id, 200);
    return { exports: await listCompositionExports({ businessId: id, organizationId: business.organizationId, actorId: user.id }) };
  });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { id } = await context.params, { user, business } = await requireBusiness(id, true), input = actions.parse(await readBody(request));
    await rateLimit("exports:write", user.id, 40);
    const scope = { businessId: id, organizationId: business.organizationId, actorId: user.id };
    if (input.action === "save") return saveCompositionExport(scope, input.compositionId, input.placement);
    if (input.action === "archive") return archiveCompositionExport(scope, input.exportId);
    return reconcileCompositionExport(scope, input.exportId);
  });
}
