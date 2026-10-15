import { z } from "zod";
import { requireUser, rateLimit } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { acceptTeamInvitation } from "@/lib/identity/teams";
import { tokenSchema } from "@/lib/identity/service";
export async function POST(request: Request) {
  return api(async () => { const user = await requireUser(); const input = z.object({ token: tokenSchema }).strict().parse(await readBody(request)); await rateLimit("team:accept", user.id, 12); return acceptTeamInvitation(user.id, input.token); });
}
