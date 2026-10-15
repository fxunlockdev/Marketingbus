import { z } from "zod";
import { requireUser, rateLimit } from "@/lib/auth";
import { api, readBody } from "@/lib/http";
import { acceptTeamInvitation, previewTeamInvitation } from "@/lib/identity/teams";
import { tokenSchema } from "@/lib/identity/service";
export async function POST(request: Request) {
  return api(async () => {
    const input = z.object({ token: tokenSchema, action: z.enum(["preview", "accept"]).default("accept") }).strict().parse(await readBody(request));
    if (input.action === "preview") {
      await rateLimit("team:preview-global", "all", 250); await rateLimit("team:preview", input.token, 20);
      return previewTeamInvitation(input.token);
    }
    const user = await requireUser(); await rateLimit("team:accept", user.id, 12); return acceptTeamInvitation(user.id, input.token);
  });
}
