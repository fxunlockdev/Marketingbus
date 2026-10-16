import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { PrismaClient } from "@prisma/client";
test("billing displays real empty balances and cannot grant credits through checkout", async ({ page }) => {
  const headers = { Origin: "http://127.0.0.1:3000" };
  expect((await page.request.post("/api/auth/register", { headers, data: { name: "Billing browser fixture", email: `billing-${crypto.randomUUID()}@example.test`, password: "Test-only-password-2026!" } })).ok()).toBe(true);
  await page.goto("/studio");
  await page.getByRole("button", { name: "Credits", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Production credits", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Revision credits", exact: true })).toBeVisible();
  await expect(page.getByText("Payments are not activated. You cannot be charged here yet.", { exact: true })).toBeVisible();
  await expect(page.getByText("No verified payments yet.", { exact: true })).toBeVisible();
  await expect(page.getByText("No offers are on sale yet.", { exact: true })).toBeVisible();
  await expect(page.getByText("No credit activity yet.", { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).include("main").analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const denied = await page.request.get("/api/organizations/not-my-workspace/billing");
  expect(denied.status()).toBe(404);
  const webhook = await page.request.post("/api/billing/webhook", { data: { kind: "PAID", generalCredits: 1000000 } });
  expect(webhook.status()).toBe(503);
});
test("billing return shows verified records and scoped refund uncertainty, never grants credits", async ({ page }) => {
  const local = process.env.TEST_DATABASE_URL;
  test.skip(!local, "Explicit local fixture database required.");
  if (local !== process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(local!).hostname)) throw Error("Refusing non-local fixture writes");
  const db = new PrismaClient(), email = `billing-status-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Billing status fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const user = await db.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } }); organizationId = user.memberships[0].organizationId;
    const checkout = await db.billingCheckout.create({ data: { organizationId, actorId: user.id, status: "UNKNOWN", offer: {}, expiresAt: new Date(Date.now() + 3600000), url: "https://checkout.stripe.com/private-fixture" } });
    const payment = await db.billingPayment.create({ data: { id: `pi_${crypto.randomUUID().replaceAll("-", "")}`, organizationId, amountMinor: 80000, currency: "usd", generalCredits: 800, revisionCredits: 0 } });
    await db.billingRefundOperation.create({ data: { id: crypto.randomUUID(), paymentId: payment.id, organizationId, amountMinor: 40000, status: "UNKNOWN", operatorId: "private-staff-identity", evidence: "private-support-case-evidence" } });
    await page.goto("/studio?billing=returned&paid=true&credits=999999");
    await expect(page.getByRole("heading", { name: "Checkout status", exact: true })).toBeVisible();
    await expect(page.getByText("Awaiting confirmation—support must check the existing request", { exact: false })).toBeVisible();
    await expect(page.getByText("Checkout outcome needs confirmation", { exact: false })).toBeVisible();
    const endpoint = `/api/organizations/${organizationId}/billing`, response = await page.request.get(endpoint), body = await response.text();
    for (const hidden of ["private-staff", "private-support", "private-fixture", "providerRefundId", "STRIPE_SECRET"]) expect(body).not.toContain(hidden);
    expect(JSON.parse(body).wallet.available).toBe(0);
    expect((await page.request.post(endpoint, { headers, data: { action: "refund", paymentId: payment.id, amountMinor: 40000 } })).status()).toBe(400);
    await db.billingCheckout.update({ where: { id: checkout.id }, data: { status: "PAID" } });
    await page.getByRole("button", { name: "Refresh billing", exact: true }).click();
    await expect(page.getByText("Payment verified and credits recorded", { exact: false })).toBeVisible();
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "../outputs/marketingbus-billing-status.png", fullPage: true });
    await db.membership.updateMany({ where: { organizationId }, data: { role: "VIEWER" } });
    await page.getByRole("button", { name: "Refresh billing", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Refund status", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Checkout status", exact: true })).toHaveCount(0);
    expect(await db.creditEntry.count({ where: { organizationId } })).toBe(0);
  } finally {
    if (organizationId) { await db.billingRefundOperation.deleteMany({ where: { organizationId } }); await db.billingPayment.deleteMany({ where: { organizationId } }); await db.organization.delete({ where: { id: organizationId } }); }
    await db.user.deleteMany({ where: { email } }); await db.$disconnect();
  }
});
