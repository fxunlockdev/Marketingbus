import { z } from "zod";
import { db } from "@/lib/db";
import { requireBusiness, rateLimit } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { exportComposition, manageComposition } from "@/lib/composition/service";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params, { user, business } = await requireBusiness(id);
    const scope = { businessId: id, organizationId: business.organizationId, actorId: user.id }, params = new URL(request.url).searchParams;
    if (!params.has("export")) return api(async () => ({ compositions: await db.staticComposition.findMany({ where: { businessId: id, organizationId: business.organizationId, status: { not: "SUPERSEDED" } }, orderBy: { createdAt: "desc" }, take: 100 }) }));
    await rateLimit("composition:render", user.id, 60);
    const input = z.object({ export: z.string().min(1).max(100), placement: z.enum(["square", "portrait", "story", "landscape"]).default("square"), format: z.enum(["png", "svg", "json"]).default("png"), preview: z.enum(["true", "false"]).default("false") }).strict().parse(Object.fromEntries(params));
    const result = await exportComposition(scope, input.export, input.placement, input.preview === "true");
    const payload = input.format === "json" ? Buffer.from(JSON.stringify(result.document, null, 2)) : result[input.format];
    return new Response(new Uint8Array(payload), { headers: { "Content-Type": { png: "image/png", svg: "image/svg+xml", json: "application/json" }[input.format], "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; img-src data:; sandbox", "Content-Disposition": `${input.preview === "true" && input.format === "png" ? "inline" : "attachment"}; filename=creative-${input.placement}.${input.format}` } });
  } catch (error) { return api(async () => { throw error; }); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => { const { id } = await context.params, { user, business } = await requireBusiness(id, true); const input = await readBody(request); await rateLimit("composition:write", user.id, 60); return manageComposition({ businessId: id, organizationId: business.organizationId, actorId: user.id }, input); });
}
