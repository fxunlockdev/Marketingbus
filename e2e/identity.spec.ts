import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Requires explicitly configured local database.");
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Refusing non-local identity fixture writes");
const db = new PrismaClient();
test.afterAll(async () => { await db.$disconnect(); });
test("explicit email verification and one-use recovery revoke old sessions", async ({ page }) => {
  const email = `identity-browser-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let userId: string | undefined, organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Identity Fixture", email, password: "old-password-fixture-2026" } })).ok()).toBe(true);
    const user = await db.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } }); userId = user.id; organizationId = user.memberships[0].organizationId;
    await page.goto("/account"); await expect(page.getByText("Email not verified", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send verification link" })).toBeDisabled();
    async function fixtureLink(kind: string) {
      const raw = randomBytes(32).toString("base64url");
      await db.identityToken.create({ data: { id: createHash("sha256").update(raw).digest("hex"), userId: user.id, kind, expiresAt: new Date(Date.now() + 60000) } });
      return { raw, url: `/account-link#${new URLSearchParams({ kind, token: raw })}` };
    }
    const verify = await fixtureLink("VERIFY_EMAIL"); await page.goto(verify.url);
    await expect(page.getByRole("button", { name: "Verify email address" })).toBeVisible();
    expect(new URL(page.url()).hash).toBe(""); expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).toBeNull();
    await page.getByRole("button", { name: "Verify email address" }).click(); await expect(page.getByRole("status")).toContainText("Email address verified");
    await page.goto("/account"); await expect(page.getByText("Email verified", { exact: true })).toBeVisible();
    const reset = await fixtureLink("RESET_PASSWORD"); await page.goto(reset.url);
    await page.getByLabel("New password", { exact: true }).fill("new-password-fixture-2026"); await page.getByLabel("Confirm new password").fill("wrong-password-fixture-2026");
    await page.getByRole("button", { name: "Update password" }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("do not match");
    await page.getByLabel("Confirm new password").fill("new-password-fixture-2026"); await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByRole("status")).toContainText("All previous sessions have been signed out");
    expect((await page.request.get("/api/identity")).status()).toBe(401);
    expect((await page.request.post("/api/identity", { headers, data: { action: "reset", token: reset.raw, password: "another-password-fixture" } })).status()).toBe(400);
    expect((await page.request.post("/api/auth/login", { headers, data: { email, password: "old-password-fixture-2026" } })).status()).toBe(401);
    expect((await page.request.post("/api/auth/login", { headers, data: { email, password: "new-password-fixture-2026" } })).ok()).toBe(true);
    await page.goto("/recover"); await page.getByLabel("Email address").fill(email); await page.getByRole("button", { name: "Send recovery link" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("not configured");
    expect(await db.emailOutbox.count({ where: { userId: user.id } })).toBe(0);
  } finally { if (organizationId) await db.organization.delete({ where: { id: organizationId } }); if (userId) await db.user.delete({ where: { id: userId } }); }
});
