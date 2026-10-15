import { requireUser, rateLimit } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { manageTeam, readTeam } from "@/lib/identity/teams";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => { const user = await requireUser(), { id } = await context.params; return readTeam(id, user.id); });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => { const user = await requireUser(), { id } = await context.params; const input = await readBody(request); await rateLimit("team:write", user.id, 60); return manageTeam(id, user.id, input); });
}
