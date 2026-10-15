import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import { decodeBase32, totp } from "../src/lib/identity/totp";

const local = process.env.TEST_DATABASE_URL;
test.skip(!local || !process.env.CI, "Requires isolated localhost fixture server with ephemeral MFA keyring.");
if (local && (process.env.DATABASE_URL !== local || !["localhost", "127.0.0.1"].includes(new URL(local).hostname)))
  throw Error("Refusing non-local fixture writes");
const db = new PrismaClient();
test.afterAll(async () => db.$disconnect());

test("authenticator enrollment, enforced sign-in, one-use recovery and disable", async ({ page }) => {
  const email = `mfa-browser-${crypto.randomUUID()}@example.test`;
  const password = "Test-only-password-2026!";
  const headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "MFA Fixture", email, password } })).ok()).toBe(true);
    const user = await db.user.update({ where: { email }, data: { emailVerifiedAt: new Date() }, include: { memberships: true } });
    organizationId = user.memberships[0]?.organizationId;
    await page.goto("/account");
    await expect(page.getByRole("button", { name: "Set up authenticator" })).toBeEnabled();
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.getByLabel("Current password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Set up authenticator" }).click();
    const secret = await page.locator("code").filter({ hasText: /^[A-Z2-7]{32}$/ }).innerText();
    await page.getByLabel("Authenticator code", { exact: true }).fill(totp(decodeBase32(secret), Date.now()));
    await page.getByRole("button", { name: "Confirm authenticator" }).click();
    await expect(page.getByRole("heading", { name: "Save these recovery codes now" })).toBeVisible();
    const recovery = await page.locator("li code").allTextContents();
    expect(recovery).toHaveLength(8);
    expect((await page.request.get("/api/mfa")).status()).toBe(401);
    expect((await page.request.post("/api/auth/login", { headers, data: { email, password } })).status()).toBe(401);
    await page.getByRole("link", { name: "Sign in again" }).click();
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Authenticator or recovery code (if enabled)").fill(recovery[0]);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/studio/);
    expect((await page.request.post("/api/auth/login", { headers, data: { email, password, code: recovery[0] } })).status()).toBe(401);
    await page.goto("/account");
    await expect(page.getByText("MFA enabled · 7 recovery codes remaining")).toBeVisible();
    await page.getByLabel("Current password", { exact: true }).fill(password);
    await page.getByLabel("Authenticator or recovery code", { exact: true }).fill(recovery[1]);
    await page.getByRole("button", { name: "Disable MFA and sign out" }).click();
    await expect(page.getByText("Security settings updated. All sessions were signed out.")).toBeVisible();
    expect((await page.request.get("/api/mfa")).status()).toBe(401);
    expect((await page.request.post("/api/auth/login", { headers, data: { email, password } })).ok()).toBe(true);
    expect((await page.request.get("/api/mfa")).headers()["cache-control"]).toBe("no-store");
  } finally {
    if (organizationId) await db.organization.delete({ where: { id: organizationId } });
    await db.user.deleteMany({ where: { email } });
  }
});
