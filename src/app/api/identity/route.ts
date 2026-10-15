import { z } from "zod";
import { api, readBody } from "@/lib/http";
import { rateLimit, requireUser } from "@/lib/auth";
import { consumeIdentityToken, emailConfiguration, passwordSchema, queueIdentityEmail, tokenSchema } from "@/lib/identity/service";
const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request-reset"), email: z.email().max(254).transform(v => v.toLowerCase()) }).strict(),
  z.object({ action: z.literal("request-verification") }).strict(),
  z.object({ action: z.literal("verify"), token: tokenSchema }).strict(),
  z.object({ action: z.literal("reset"), token: tokenSchema, password: passwordSchema }).strict(),
]);
export async function GET() {
  return api(async () => {
    const user = await requireUser(); let emailAvailable = false;
    try { emailConfiguration(); emailAvailable = true; } catch { /* Configuration never returned. */ }
    return { email: user.email, verified: !!user.emailVerifiedAt, emailAvailable };
  });
}
export async function POST(request: Request) {
  return api(async () => {
    const input = inputSchema.parse(await readBody(request));
    await rateLimit("identity:global", "all", 200);
    if (input.action === "request-reset") {
      await rateLimit("identity:request", input.email, 5);
      return queueIdentityEmail(input.email, "RESET_PASSWORD");
    }
    if (input.action === "request-verification") {
      const user = await requireUser(); await rateLimit("identity:request", user.email, 5);
      return queueIdentityEmail(user.email, "VERIFY_EMAIL");
    }
    await rateLimit("identity:consume", input.token, 5);
    return consumeIdentityToken(input.token, input.action === "verify" ? "VERIFY_EMAIL" : "RESET_PASSWORD", input.action === "reset" ? input.password : undefined);
  });
}
