import { requireUser, rateLimit } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { readBilling, manageBilling } from "@/lib/billing/payments";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => { const user = await requireUser(), { id } = await context.params; return readBilling({ organizationId: id, actorId: user.id }); });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => { const user = await requireUser(), { id } = await context.params, body = await readBody(request); await rateLimit("billing:manage", user.id, 20); return manageBilling({ organizationId: id, actorId: user.id }, body); });
}
