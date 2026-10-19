import { z } from "zod";
import { compare, hash } from "bcryptjs";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { api, AppError, readBody } from "@/lib/http";
import { endSession, rateLimit, startSession } from "@/lib/auth";
import { requirePilotInvitation } from "@/lib/pilot-access";
import { passwordSchema, tokenSchema } from "@/lib/identity/service";
import { verifyLoginFactor } from "@/lib/identity/mfa";
import { registerInvitedUser } from "@/lib/identity/teams";
import { applyPilotCredit } from "@/lib/billing/pilot-credit";
const credentials = z.object({ email: z.email().max(254).transform(v=>v.toLowerCase()), password: z.string().min(12).max(64), name: z.string().trim().min(2).max(80).optional(), invitationCode: z.string().max(128).optional(), teamInvitationToken: tokenSchema.optional(), code: z.string().max(64).optional() }).strict();
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  return api(async () => {
    const { action } = await context.params; const body = await readBody(request);
    if (action === "logout") { await endSession(); return { ok:true }; }
    if (!["login","register"].includes(action)) throw new AppError(404,"Not found.");
    const input = credentials.parse(body);
    await rateLimit(`auth:${action}`,input.email,12);
    await rateLimit("auth:global", "all", 250);
    if (action === "register") {
      if (!input.teamInvitationToken) requirePilotInvitation(input.invitationCode);
      passwordSchema.parse(input.password);
      if (!input.name) throw new AppError(400,"Enter your name.");
      try {
        if (input.teamInvitationToken) {
          await rateLimit("team:register", input.teamInvitationToken, 6);
          const user = await registerInvitedUser({ token: input.teamInvitationToken, email: input.email, password: input.password, name: input.name });
          await startSession(user.id, user.authVersion); return { ok: true, joined: true };
        }
        const passwordHash = await hash(input.password,12);
        const user = await db.user.create({ data: { email:input.email, name:input.name, passwordHash, memberships:{ create:{ role:"OWNER", organization:{ create:{ name:`${input.name}'s studio`, wallet:{create:{}} } } } } } });
        await startSession(user.id, user.authVersion); return { ok:true };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new AppError(409,"Unable to create this account. Try signing in instead.");
        throw error;
      }
    }
    const user = await db.user.findUnique({where:{email:input.email}});
    // Same expensive password operation for missing accounts to reduce timing disclosure.
    const encoded = user?.passwordHash ?? "$2b$12$OMhSnhGn5b4/70.mTSv32ez0qTuasoghWtlEMhCPuDbO0xYNDfxZy";
    if (!await compare(input.password,encoded) || !user) throw new AppError(401,"Email or password is incorrect.");
    const version = await verifyLoginFactor(user.id, user.authVersion, input.code);
    // Allocations are optional operator configuration, never public signup gifts.
    // Misconfiguration must not lock an otherwise valid customer out of login.
    try { await applyPilotCredit(user.id, version); } catch { console.error("Pilot allocation unavailable; account login remains available."); }
    await startSession(user.id, version); return { ok:true };
  });
}
