import { requireBusiness, rateLimit } from "@/lib/auth";
import { api } from "@/lib/http";
import { readCompositionExport } from "@/lib/composition/exports";
export async function GET(_request: Request, context: { params: Promise<{ id: string; exportId: string }> }) {
  try {
    const { id, exportId } = await context.params, { user, business } = await requireBusiness(id);
    await rateLimit("exports:download", user.id, 120);
    const result = await readCompositionExport({ businessId: id, organizationId: business.organizationId, actorId: user.id }, exportId);
    return new Response(new Uint8Array(result.bytes), { headers: { "Content-Type": "image/png", "Content-Disposition": `attachment; filename=approved-${result.placement}.png`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } });
  } catch (error) { return api(async () => { throw error; }); }
}
