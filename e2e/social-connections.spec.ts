import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Requires explicit localhost fixture database.");
if (local && (process.env.DATABASE_URL !== local || !["localhost", "127.0.0.1"].includes(new URL(local).hostname))) throw Error("Refusing non-local fixture writes");
const db = new PrismaClient();
test.afterAll(async () => db.$disconnect());
test("publishing connections are scoped, fail closed, hide secrets and allow cancellation", async ({ page, browser }) => {
  const email = `oauth-browser-${randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "OAuth browser fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const response = await page.request.post("/api/businesses", { headers, data: { name: "Connections studio", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["Facebook"] } });
    const { id } = await response.json(); organizationId = (await db.business.findUniqueOrThrow({ where: { id } })).organizationId;
    const user = await db.user.findUniqueOrThrow({ where: { email } }), session = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    const flowId = randomUUID();
    await db.socialOAuthFlow.create({ data: { id: flowId, businessId: id, organizationId, actorId: user.id, sessionId: session.id, provider: "Facebook", stateHash: `fixture-${randomUUID()}`, configurationHash: "private-config-fixture", encryptedVerifier: "synthetic-secret-not-a-real-verifier", expiresAt: new Date(Date.now() + 600000) } });
    const connection = await db.socialConnection.create({ data: { businessId: id, organizationId, provider: "Facebook", externalAccountId: "private-destination-fixture", label: "Fixture company page", encryptedToken: "synthetic-private-token", permissions: [] } });
    const endpoint = `/api/businesses/${id}/connections`, api = await page.request.get(endpoint), body = await api.text();
    expect(api.ok()).toBe(true); expect(api.headers()["cache-control"]).toContain("no-store");
    for (const hidden of ["synthetic-secret", "synthetic-private-token", "private-config-fixture", "private-destination-fixture", "stateHash", "sessionId", "encrypted"]) expect(body).not.toContain(hidden);
    await page.goto("/studio"); await page.getByRole("button", { name: "Connections", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Publishing destinations", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Disconnect Fixture company page", exact: true })).toBeVisible();
    for (const provider of ["Instagram", "Facebook", "LinkedIn"]) await expect(page.getByRole("button", { name: `Connect ${provider}`, exact: true })).toBeDisabled();
    for (const provider of ["OpenAI", "Gemini", "Higgsfield"]) await expect(page.getByRole("heading", { name: provider, exact: true })).toHaveCount(0);
    expect((await page.request.post(endpoint, { headers, data: { action: "begin", provider: "Facebook" } })).status()).toBe(503);
    expect((await page.request.post(endpoint, { headers: { Origin: "https://attacker.example" }, data: { action: "cancel", flowId } })).status()).toBe(403);
    expect((await page.request.post(endpoint, { headers, data: { action: "choose", flowId, choiceId: randomUUID(), token: "forged" } })).status()).toBe(400);
    await page.getByRole("button", { name: "Cancel connection request", exact: true }).click();
    await expect(page.getByText("Connection request cancelled.")).toBeVisible();
    expect(await db.socialOAuthFlow.findUnique({ where: { id: flowId } })).toMatchObject({ status: "CANCELLED", encryptedVerifier: null });
    const disconnect = page.getByRole("button", { name: "Disconnect Fixture company page", exact: true });
    await disconnect.focus(); page.once("dialog", dialog => dialog.dismiss()); await page.keyboard.press("Enter");
    await expect(disconnect).toBeFocused();
    expect(await db.socialConnection.findUnique({ where: { id: connection.id } })).toMatchObject({ status: "CONNECTED", encryptedToken: "synthetic-private-token" });
    // A refreshed grant must not be disconnected by a stale open screen.
    await db.socialConnection.update({ where: { id: connection.id }, data: { authorizationVersion: 2 } });
    page.once("dialog", dialog => dialog.accept()); await disconnect.click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Account access changed");
    expect((await page.request.post(`/api/businesses/${id}/social`, { headers, data: { action: "disconnect", connectionId: connection.id } })).status()).toBe(400);
    expect((await page.request.post(endpoint, { headers: { Origin: "https://attacker.example" }, data: { action: "disconnect", connectionId: connection.id, authorizationVersion: 2 } })).status()).toBe(403);
    await page.getByRole("button", { name: "Refresh connections", exact: true }).click();
    await expect(disconnect).toBeEnabled();
    page.once("dialog", dialog => dialog.accept()); await disconnect.focus(); await page.keyboard.press("Enter");
    const outcome = page.getByRole("status").filter({ hasText: "Account disconnected from Marketingbus" });
    await expect(outcome).toBeVisible(); await expect(outcome).toBeFocused();
    await expect(disconnect).toHaveCount(0);
    expect(await db.socialConnection.findUnique({ where: { id: connection.id } })).toMatchObject({ status: "DISCONNECTED", encryptedToken: "", authorizationVersion: 3 });
    expect(await db.auditEvent.count({ where: { businessId: id, action: "SOCIAL_DISCONNECTED" } })).toBe(1);
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("region", { name: "Publishing connections" }).screenshot({ path: "../outputs/marketingbus-publishing-connections.png" });
    await db.membership.updateMany({ where: { organizationId }, data: { role: "VIEWER" } });
    expect((await page.request.post(endpoint, { headers, data: { action: "cancel", flowId } })).status()).toBe(403);
    expect((await page.request.post(endpoint, { headers, data: { action: "disconnect", connectionId: connection.id, authorizationVersion: 3 } })).status()).toBe(403);
    await page.reload(); await page.getByRole("button", { name: "Connections", exact: true }).click();
    await expect(page.getByText("Only a workspace owner or admin can manage connections.")).toBeVisible();
    const anonymous = await browser.newContext();
    try {
      expect((await anonymous.request.get(`http://127.0.0.1:3000${endpoint}`)).status()).toBe(401);
      expect((await anonymous.request.post(`http://127.0.0.1:3000${endpoint}`, { headers, data: { action: "disconnect", connectionId: connection.id, authorizationVersion: 3 } })).status()).toBe(401);
    } finally { await anonymous.close(); }
    expect(await db.job.count({ where: { organizationId } })).toBe(0);
  } finally {
    if (organizationId) await db.organization.delete({ where: { id: organizationId } });
    await db.user.deleteMany({ where: { email } });
  }
});
test("OAuth callback errors redact parameters and redirect only to a fixed local recovery page", async ({ page }) => {
  const response = await page.request.get("/api/social/facebook/callback?state=private-state&code=private-code&error_description=private-description&next=https://attacker.example", { maxRedirects: 0 });
  expect(response.status()).toBe(303); expect(response.headers().location).toBe("/social-connect?failed=1");
  expect(response.headers()["cache-control"]).toContain("no-store"); expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  expect(await response.text()).toBe("");
  await page.goto("/social-connect?failed=1"); await expect(page.getByRole("heading", { name: "Connection not completed" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Return to your studio" })).toHaveAttribute("href", "/studio");
  expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});
