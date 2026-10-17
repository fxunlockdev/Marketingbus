import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import { decodeBase32, totp } from "../src/lib/identity/totp";

const local = process.env.TEST_DATABASE_URL;
test.skip(!local || !process.env.CI, "Requires isolated local fixture server and ephemeral encryption keys.");
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Local fixtures only");
const db = new PrismaClient();
test.afterAll(async () => db.$disconnect());

test("owner requires MFA, existing member is gated, enrollment restores access and owner can relax policy", async ({ page, browser }) => {
  test.setTimeout(60000);
  const headers = { Origin: "http://127.0.0.1:3000" }, password = "Test-only-password-2026!";
  const orgs: string[] = [], users: string[] = [];
  const memberContext = await browser.newContext({ baseURL: "http://127.0.0.1:3000" });
  const memberPage = await memberContext.newPage();
  async function register(request: APIRequestContext, name: string) {
    const email = `policy-${crypto.randomUUID()}@example.test`;
    expect((await request.post("/api/auth/register", { headers, data: { name, email, password } })).ok()).toBe(true);
    const user = await db.user.update({ where: { email }, data: { emailVerifiedAt: new Date() }, include: { memberships: true } });
    users.push(user.id); orgs.push(user.memberships[0].organizationId); return user;
  }
  async function enroll(request: APIRequestContext, email: string) {
    const begin = await request.post("/api/mfa", { headers, data: { action: "begin", password } });
    expect(begin.ok()).toBe(true);
    const setup = await begin.json();
    const confirmed = await request.post("/api/mfa", { headers, data: { action: "confirm", password, code: totp(decodeBase32(setup.secret), Date.now()) } });
    expect(confirmed.ok()).toBe(true);
    const codes: string[] = (await confirmed.json()).recoveryCodes;
    expect((await request.get("/api/mfa")).status()).toBe(401);
    expect((await request.post("/api/auth/login", { headers, data: { email, password, code: codes[0] } })).ok()).toBe(true);
    return codes;
  }
  try {
    const owner = await register(page.request, "Policy owner");
    const organizationId = orgs[0], securityUrl = `/api/workspaces/${organizationId}/security`;
    const business = await db.business.create({ data: { organizationId, name: "Protected brand fixture", offering: "Architecture consultations" } });
    const member = await register(memberPage.request, "Policy member");
    await db.membership.create({ data: { organizationId, userId: member.id, role: "ADMIN" } });
    await db.business.create({ data: { organizationId: orgs[1], name: "Unrelated brand fixture" } });
    expect((await memberPage.request.get(`/api/workspaces/${organizationId}/team`)).ok()).toBe(true);
    const ownerCodes = await enroll(page.request, owner.email);
    await page.goto("/studio");
    await page.getByRole("button", { name: "Team", exact: true }).click();
    const policy = page.getByRole("heading", { name: "Workspace security", exact: true });
    await expect(policy).toBeVisible();
    await expect(page.getByRole("button", { name: "Require workspace MFA", exact: true })).toBeDisabled();
    await page.getByLabel("Owner password", { exact: true }).fill(password);
    await page.getByLabel("Owner authenticator or recovery code", { exact: true }).fill(ownerCodes[1]);
    await page.getByRole("checkbox", { name: /members without MFA will lose/ }).focus();
    await page.keyboard.press("Space");
    await page.getByRole("button", { name: "Require workspace MFA", exact: true }).click();
    await expect(page.getByText("Two-step verification is required for this workspace.", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Owner password", { exact: true })).toHaveValue("");
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    for (const url of [`/api/workspaces/${organizationId}/team`, `/api/organizations/${organizationId}/billing`]) {
      const response = await memberPage.request.get(url);
      expect(response.status()).toBe(403); expect(response.headers()["cache-control"]).toBe("no-store");
    }
    expect((await memberPage.request.get(`/api/businesses/${business.id}/planning`)).status()).toBe(404);
    expect((await memberPage.request.post(securityUrl, { headers, data: { requireMfa: false, expectedRequireMfa: true, password, code: "000000" } })).status()).toBe(403);
    await memberPage.goto("/studio");
    await expect(memberPage.getByRole("link", { name: "Set up MFA in Account security" })).toBeVisible();
    expect(await memberPage.content()).not.toContain("Protected brand fixture");
    await expect(memberPage.getByRole("combobox", { name: "YOUR WORKSPACE" }).locator("option:checked")).toHaveText("Unrelated brand fixture");
    await memberPage.getByRole("link", { name: "Set up MFA in Account security" }).click();
    await expect(memberPage.getByRole("button", { name: "Set up authenticator" })).toBeEnabled();
    const memberCodes = await enroll(memberPage.request, member.email);
    expect((await memberPage.request.get(`/api/workspaces/${organizationId}/team`)).ok()).toBe(true);
    expect((await memberPage.request.post(securityUrl, { headers, data: { requireMfa: false, expectedRequireMfa: true, password, code: memberCodes[1] } })).status()).toBe(403);
    expect((await memberPage.request.post("/api/mfa", { headers, data: { action: "disable", password, code: memberCodes[1] } })).status()).toBe(409);
    await memberPage.goto("/account");
    await expect(memberPage.getByRole("button", { name: "Disable MFA and sign out" })).toBeDisabled();
    await page.getByLabel("Owner password", { exact: true }).fill(password);
    await page.getByLabel("Owner authenticator or recovery code", { exact: true }).fill(ownerCodes[2]);
    await page.getByRole("checkbox", { name: /makes MFA optional/ }).check();
    await page.getByRole("button", { name: "Make workspace MFA optional", exact: true }).click();
    await expect(page.getByText("Two-step verification is optional for this workspace.", { exact: true })).toBeVisible();
    expect((await memberPage.request.get("/api/mfa")).ok()).toBe(true);
    expect((await db.mfaCredential.findUnique({ where: { userId: member.id } }))?.enabledAt).not.toBeNull();
    expect(await db.teamEvent.count({ where: { organizationId, action: { in: ["MFA_REQUIRED", "MFA_OPTIONAL"] } } })).toBe(2);
    expect(await db.wallet.findUnique({ where: { organizationId } })).toMatchObject({ available: 0, held: 0 });
    expect((await page.request.post("/api/auth/logout", { headers, data: {} })).ok()).toBe(true);
    expect((await page.request.post(securityUrl, { headers, data: {} })).status()).toBe(401);
  } finally {
    await memberContext.close();
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  }
});
