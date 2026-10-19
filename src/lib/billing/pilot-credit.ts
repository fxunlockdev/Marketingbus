import { z } from "zod";
import { db } from "../db";
import { addCreditsInTransaction } from "./wallet";

const grants = z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/), email: z.email().transform(s => s.toLowerCase()), credits: z.number().int().min(1).max(1000), expiresAt: z.iso.datetime() }).strict()).max(5);
// Operator-only, exact-email pilot allocation. No client chooses recipients or
// amounts. This does not raise supplier budgets, subscribe anyone or call AI.
export async function applyPilotCredit(userId: string, authVersion: number) {
  if (!process.env.PILOT_CREDIT_GRANTS_JSON) return false;
  const configured = grants.parse(JSON.parse(process.env.PILOT_CREDIT_GRANTS_JSON));
  if (new Set(configured.map(g => g.id)).size !== configured.length || new Set(configured.map(g => g.email)).size !== configured.length) throw Error("Duplicate pilot credit configuration");
  return db.$transaction(async tx => {
    const user = await tx.user.findUnique({ where: { id: userId }, include: { memberships: { where: { role: "OWNER" }, take: 2 } } });
    if (!user || user.authVersion !== authVersion || user.memberships.length !== 1) return false;
    const grant = configured.find(g => g.email === user.email.toLowerCase());
    if (!grant || Date.parse(grant.expiresAt) <= Date.now()) return false;
    if (Date.parse(grant.expiresAt) > Date.now() + 7 * 86400000) throw Error("Pilot allocation expiry must be within seven days");
    const organizationId = user.memberships[0].organizationId, key = `operator-pilot:${grant.id}`;
    await tx.$queryRaw`SELECT "organizationId" FROM "Wallet" WHERE "organizationId"=${organizationId} FOR UPDATE`;
    const previous = await tx.creditEntry.findUnique({ where: { key } });
    if (previous) {
      if (previous.organizationId !== organizationId || previous.amount !== grant.credits || previous.kind !== "TEST_GRANT") throw Error("Pilot allocation replay changed");
      return false;
    }
    await addCreditsInTransaction(tx, organizationId, grant.credits, 0);
    await tx.creditEntry.create({ data: { organizationId, key, kind: "TEST_GRANT", amount: grant.credits } });
    return true;
  });
}
