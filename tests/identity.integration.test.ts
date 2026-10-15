import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { compare } from "bcryptjs";
import { db } from "../src/lib/db";
import { consumeIdentityToken, emailConfiguration, expireIdentityArtifacts, passwordSchema, queueIdentityEmail } from "../src/lib/identity/service";
import { runOneEmail } from "../src/lib/identity/worker";
import { openSecret, sealSecret } from "../src/lib/secrets";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local test DB required");
suite("identity and encrypted Resend outbox", () => {
  const users: string[] = [];
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await db.user.deleteMany({ where: { id: { in: users } } }); await db.$disconnect(); });
  function enable() {
    vi.stubEnv("EMAIL_DELIVERY_ENABLED", "true"); vi.stubEnv("RESEND_API_KEY", "fake-test-only-key"); vi.stubEnv("RESEND_FROM_EMAIL", "studio@example.test"); vi.stubEnv("APP_ORIGIN", "https://studio.example.test"); vi.stubEnv("EMAIL_DAILY_LIMIT", "1000");
    vi.stubEnv("SECRET_ENCRYPTION_ACTIVE_KEY", "test1"); vi.stubEnv("SECRET_ENCRYPTION_KEYS_JSON", JSON.stringify({ test1: Buffer.alloc(32, 1).toString("base64") }));
  }
  async function setup() { enable(); const user = await db.user.create({ data: { email: `identity-${crypto.randomUUID()}@example.test`, name: "Identity Fixture", passwordHash: "fixture-not-a-real-password" } }); users.push(user.id); return user; }
  async function linkFor(userId: string, kind: string) {
    const mail = await db.emailOutbox.findFirstOrThrow({ where: { userId, kind }, orderBy: { createdAt: "desc" } });
    const payload = JSON.parse(openSecret(mail.encryptedPayload, `email:${mail.id}:${userId}`));
    const link = new URL(payload.text.match(/https:\/\/[^\s]+/)[0]);
    return { mail, token: new URLSearchParams(link.hash.slice(1)).get("token")!, link };
  }
  it("authenticates encrypted envelopes and supports key rotation without cross-context reads", () => {
    enable(); const secret = sealSecret("private-token", "email:a:user-a");
    expect(secret).not.toContain("private-token"); expect(openSecret(secret, "email:a:user-a")).toBe("private-token");
    expect(() => openSecret(secret, "email:a:user-b")).toThrow();
    const parts = secret.split("."); parts[4] = Buffer.from("tampered").toString("base64url"); expect(() => openSecret(parts.join("."), "email:a:user-a")).toThrow();
    vi.stubEnv("SECRET_ENCRYPTION_ACTIVE_KEY", "test2"); vi.stubEnv("SECRET_ENCRYPTION_KEYS_JSON", JSON.stringify({ test1: Buffer.alloc(32, 1).toString("base64"), test2: Buffer.alloc(32, 2).toString("base64") }));
    expect(openSecret(secret, "email:a:user-a")).toBe("private-token"); expect(sealSecret("new", "context")).toContain(".test2.");
  });
  it("fails closed without credentials and rejects noncanonical origins and bcrypt truncation", () => {
    enable(); vi.stubEnv("EMAIL_DELIVERY_ENABLED", "false"); expect(() => emailConfiguration()).toThrow("not configured");
    enable(); vi.stubEnv("APP_ORIGIN", "https://attacker@example.test"); expect(() => emailConfiguration()).toThrow();
    expect(() => passwordSchema.parse("漢".repeat(30))).toThrow("72 UTF-8");
  });
  it("queues hashes and ciphertext only, returning identical results for unknown accounts", async () => {
    const user = await setup(); const known = await queueIdentityEmail(user.email, "VERIFY_EMAIL"), unknown = await queueIdentityEmail("missing@example.test", "VERIFY_EMAIL");
    expect(known).toEqual(unknown); const { token, mail, link } = await linkFor(user.id, "VERIFY_EMAIL");
    expect(link.search).toBe(""); expect(mail.encryptedPayload).not.toContain(token);
    expect((await db.identityToken.findFirstOrThrow({ where: { userId: user.id } })).id).not.toBe(token);
    await expect(consumeIdentityToken(token, "RESET_PASSWORD", "new-password-safe-2026")).rejects.toThrow("invalid or expired");
    await consumeIdentityToken(token, "VERIFY_EMAIL");
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).not.toBeNull();
    await expect(consumeIdentityToken(token, "VERIFY_EMAIL")).rejects.toThrow("invalid or expired");
  });
  it("allows exactly one concurrent password reset and revokes every session and sibling reset link", async () => {
    const user = await setup(); await db.session.create({ data: { id: crypto.randomUUID(), userId: user.id, expiresAt: new Date(Date.now() + 60000) } });
    await queueIdentityEmail(user.email, "RESET_PASSWORD"); const first = await linkFor(user.id, "RESET_PASSWORD");
    await queueIdentityEmail(user.email, "RESET_PASSWORD"); const second = await linkFor(user.id, "RESET_PASSWORD");
    const results = await Promise.allSettled([consumeIdentityToken(first.token, "RESET_PASSWORD", "new-password-safe-2026"), consumeIdentityToken(first.token, "RESET_PASSWORD", "new-password-safe-2026")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await expect(consumeIdentityToken(second.token, "RESET_PASSWORD", "another-password-2026")).rejects.toThrow("invalid or expired");
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    const changed = await db.user.findUniqueOrThrow({ where: { id: user.id } }); expect(changed.authVersion).toBe(1); expect(await compare("new-password-safe-2026", changed.passwordHash)).toBe(true);
  });
  it("rejects expired tokens and caps eligible emails per account", async () => {
    const user = await setup(); const now = new Date();
    for (let i = 0; i < 5; i++) await queueIdentityEmail(user.email, "VERIFY_EMAIL", now);
    expect(await db.emailOutbox.count({ where: { userId: user.id } })).toBe(3);
    const { token } = await linkFor(user.id, "VERIFY_EMAIL"); await expect(consumeIdentityToken(token, "VERIFY_EMAIL", undefined, new Date(now.getTime() + 3600000))).rejects.toThrow("invalid or expired");
    await db.emailOutbox.updateMany({ where: { userId: user.id }, data: { status: "EXPIRED", encryptedPayload: "" } });
  });
  it("retries uncertain provider responses with an identical body and key then clears encrypted content", async () => {
    const user = await setup(), now = new Date(); await queueIdentityEmail(user.email, "VERIFY_EMAIL", now);
    const mail = (await linkFor(user.id, "VERIFY_EMAIL")).mail;
    const requests: { body: unknown; key: string | null }[] = [];
    const transport = vi.fn(async (_url, init) => { requests.push({ body: init?.body, key: new Headers(init?.headers).get("Idempotency-Key") }); if (requests.length === 1) throw Error("ambiguous timeout"); return Response.json({ id: "resend-fixture-accepted" }); }) as unknown as typeof fetch;
    await runOneEmail(transport, now);
    expect((await db.emailOutbox.findUniqueOrThrow({ where: { id: mail.id } })).status).toBe("QUEUED");
    await runOneEmail(transport, new Date(now.getTime() + 61000)); expect(requests[0]).toEqual(requests[1]);
    expect(await db.emailOutbox.findUniqueOrThrow({ where: { id: mail.id } })).toMatchObject({ status: "ACCEPTED", providerId: "resend-fixture-accepted", encryptedPayload: "", attempts: 2 });
  });
  it("does not retry permanent provider rejection or expired queued email", async () => {
    const user = await setup(), now = new Date(); await queueIdentityEmail(user.email, "VERIFY_EMAIL", now);
    const bad = vi.fn(async () => new Response(null, { status: 422 })) as unknown as typeof fetch;
    await runOneEmail(bad, now); await runOneEmail(bad, now); expect(bad).toHaveBeenCalledTimes(1);
    expect((await db.emailOutbox.findFirstOrThrow({ where: { userId: user.id } })).status).toBe("FAILED");
    await queueIdentityEmail(user.email, "RESET_PASSWORD", now); await runOneEmail(bad, new Date(now.getTime() + 31 * 60000)); expect(bad).toHaveBeenCalledTimes(1);
    expect((await db.emailOutbox.findFirstOrThrow({ where: { userId: user.id, kind: "RESET_PASSWORD" } })).status).toBe("EXPIRED");
  });
  it("clears expired encrypted mail even when delivery has been disabled", async () => {
    const user = await setup(), now = new Date(); await queueIdentityEmail(user.email, "RESET_PASSWORD", now);
    vi.stubEnv("EMAIL_DELIVERY_ENABLED", "false");
    await expireIdentityArtifacts(new Date(now.getTime() + 31 * 60000));
    expect(await db.emailOutbox.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({ status: "EXPIRED", encryptedPayload: "" });
  });
});
