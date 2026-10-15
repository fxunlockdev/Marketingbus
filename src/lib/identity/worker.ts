import { z } from "zod";
import { db } from "../db";
import { openSecret } from "../secrets";
import { emailConfiguration } from "./service";
const payloadSchema = z.object({ from: z.email(), to: z.array(z.email()).length(1), subject: z.string().max(150), text: z.string().max(4000) }).strict();
export async function runOneEmail(transport: typeof fetch = fetch, now = new Date()) {
  const config = emailConfiguration();
  const mail = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(71403221)`;
    await tx.emailOutbox.updateMany({ where: { status: { in: ["QUEUED", "SENDING"] }, expiresAt: { lte: now } }, data: { status: "EXPIRED", encryptedPayload: "", leaseUntil: null } });
    await tx.emailOutbox.updateMany({ where: { status: "SENDING", leaseUntil: { lte: now }, attempts: { lt: 5 } }, data: { status: "QUEUED", leaseUntil: null } });
    await tx.emailOutbox.updateMany({ where: { status: "SENDING", leaseUntil: { lte: now }, attempts: { gte: 5 } }, data: { status: "FAILED", encryptedPayload: "", leaseUntil: null } });
    const candidate = await tx.emailOutbox.findFirst({ where: { status: "QUEUED", availableAt: { lte: now }, expiresAt: { gt: now }, attempts: { lt: 5 } }, orderBy: { createdAt: "asc" } });
    if (!candidate) return null;
    return tx.emailOutbox.update({ where: { id: candidate.id }, data: { status: "SENDING", attempts: { increment: 1 }, leaseUntil: new Date(now.getTime() + 60000) } });
  });
  if (!mail) return false;
  let retryable = false;
  try {
    const payload = payloadSchema.parse(JSON.parse(openSecret(mail.encryptedPayload, `email:${mail.id}:${mail.userId}`)));
    // Fixed endpoint, bounded request, identical body and idempotency key for every retry.
    retryable = true;
    const response = await transport("https://api.resend.com/emails", { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json", "Idempotency-Key": `identity/${mail.id}` }, body: JSON.stringify(payload) });
    retryable = response.status === 429 || response.status >= 500 || response.ok;
    if (!response.ok) { await response.body?.cancel(); throw Error("Email provider request rejected."); }
    const reader = response.body?.getReader(); if (!reader) throw Error("Missing email response");
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 16384) { await reader.cancel(); throw Error("Email response too large"); } chunks.push(part.value); }
    const data = z.object({ id: z.string().min(1).max(200) }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    await db.emailOutbox.updateMany({ where: { id: mail.id, status: "SENDING", attempts: mail.attempts }, data: { status: "ACCEPTED", providerId: data.id, encryptedPayload: "", leaseUntil: null } });
  } catch {
    const retry = retryable && mail.attempts < 5;
    await db.emailOutbox.updateMany({ where: { id: mail.id, status: "SENDING", attempts: mail.attempts }, data: { status: retry ? "QUEUED" : "FAILED", ...(retry ? { availableAt: new Date(now.getTime() + 30000 * 2 ** mail.attempts) } : { encryptedPayload: "" }), leaseUntil: null } });
  }
  return true;
}
