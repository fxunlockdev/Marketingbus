import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Requires explicit localhost fixture database.");
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Refusing non-local fixture writes");
const db = new PrismaClient();
test.afterAll(async () => db.$disconnect());
test("inspect and stop a weekly run without touching authorized work or credits", async ({ page }) => {
  const email = `weekly-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Weekly Fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const created = await page.request.post("/api/businesses", { headers, data: { name: "Weekly Studio", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["Facebook"] } });
    expect(created.ok()).toBe(true); const { id } = await created.json();
    const business = await db.business.findUniqueOrThrow({ where: { id } }); organizationId = business.organizationId;
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const plan = await db.productionPlan.create({ data: { businessId: id, organizationId, title: "Synthetic weekly run", brandVersion: 1, creditCeiling: 10,
      items: { create: [{ title: "Authorized creative", format: "static", channel: "Facebook", brief: {} }, { title: "Waiting creative", format: "static", channel: "Facebook", brief: {} }] } }, include: { items: true } });
    const authorized = plan.items.find(i => i.title === "Authorized creative")!, waiting = plan.items.find(i => i.title === "Waiting creative")!;
    const quote = await db.generationQuote.create({ data: { organizationId, businessId: id, itemId: authorized.id, brandVersion: 1, baseVersion: 0, mode: "initial", credits: 1, supplierCeilingMicros: 1, request: { secret: "fixture-prompt-not-for-browser" }, configurationHash: "fixture", status: "ACCEPTED", expiresAt: new Date(Date.now() + 60000) } });
    const reservation = await db.reservation.create({ data: { organizationId, key: crypto.randomUUID(), credits: 1 } });
    await db.wallet.update({ where: { organizationId }, data: { available: 9, held: 1 } });
    const job = await db.job.create({ data: { organizationId, businessId: id, kind: "STATIC_COPY", key: crypto.randomUUID(), quoteId: quote.id, reservationId: reservation.id, status: "NEEDS_RECONCILIATION", payload: { actorId: user.id }, errorCode: "fixture-private-error" } });
    await db.weeklyPolicy.create({ data: { businessId: id, organizationId, enabled: true, mode: "DRAFTS", maxItems: 2, creditsPerWeek: 10, weekday: 1, hourUTC: 9, version: 1, actorId: user.id, brandVersion: 1, nextRunAt: new Date(Date.now() + 86400000) } });
    const cycle = await db.weeklyCycle.create({ data: { businessId: id, organizationId, periodKey: "2026-10-12", policyVersion: 1, brandVersion: 1, planId: plan.id, creditsAuthorized: 1,
      tasks: { create: [{ itemId: authorized.id, quoteId: quote.id, status: "AUTHORIZED" }, { itemId: waiting.id }] } } });
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId } });
    await page.goto("/studio"); await page.getByRole("button", { name: "Workflows", exact: true }).click();
    const runs = page.getByRole("region", { name: "Weekly runs", exact: true });
    await expect(runs.getByText("Authorized creative", { exact: true })).toBeVisible();
    await expect(runs.getByText(/Outcome uncertain — operator review required/)).toBeVisible();
    await expect(runs.getByText(/1 credit held/)).toBeVisible();
    const imageOptIn = page.getByRole("checkbox", { name: "Generate one image after I approve each weekly copy draft" });
    await expect(imageOptIn).not.toBeChecked(); await expect(imageOptIn).toBeEnabled();
    await imageOptIn.focus(); await page.keyboard.press("Space"); await expect(imageOptIn).toBeChecked();
    await page.getByRole("combobox", { name: "Weekly mode", exact: true }).selectOption("PLAN");
    await expect(imageOptIn).not.toBeChecked(); await expect(imageOptIn).toBeDisabled();
    await page.getByRole("combobox", { name: "Weekly mode", exact: true }).selectOption("DRAFTS");
    await expect(imageOptIn).toBeEnabled();
    await expect(page.getByText("fixture-private-error", { exact: false })).toHaveCount(0);
    const stop = runs.getByRole("button", { name: "Stop run for 2026-10-12", exact: true });
    await stop.focus(); await page.keyboard.press("Enter");
    await expect(stop).toHaveAttribute("aria-expanded", "true");
    await runs.getByRole("button", { name: "Keep this run" }).click();
    await expect(runs.getByRole("heading", { name: "Week of 2026-10-12" })).toBeFocused();
    expect((await db.weeklyCycle.findUniqueOrThrow({ where: { id: cycle.id } })).status).toBe("OPEN");
    await stop.click(); await runs.getByRole("button", { name: "Confirm stop for 2026-10-12" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Weekly run stopped" })).toBeVisible();
    await expect(stop).toHaveCount(0); await expect(runs.getByRole("heading", { name: "Week of 2026-10-12" })).toBeFocused();
    expect((await db.weeklyTask.findFirstOrThrow({ where: { cycleId: cycle.id, itemId: waiting.id } })).status).toBe("CANCELLED");
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toEqual(job);
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId } })).toEqual(wallet);
    expect((await db.weeklyPolicy.findUniqueOrThrow({ where: { businessId: id } })).enabled).toBe(true);
    const response = await page.request.get(`/api/businesses/${id}/planning`); expect(response.headers()["cache-control"]).toBe("no-store");
    expect(await response.text()).not.toMatch(/fixture-prompt|fixture-private|actorId|quoteId|providerTaskId/);
    await runs.getByRole("button", { name: "Refresh weekly runs" }).click();
    await expect(runs.getByText(/1 credit held/)).toBeVisible();
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: "../outputs/marketingbus-weekly-cancellation.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await db.membership.update({ where: { organizationId_userId: { organizationId, userId: user.id } }, data: { role: "VIEWER" } });
    await page.reload(); await page.getByRole("button", { name: "Workflows", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save recurring authorization" })).toBeDisabled();
    expect((await page.request.post(`/api/businesses/${id}/planning`, { headers, data: { action: "cancelCycle", cycleId: cycle.id, policyVersion: 1 } })).status()).toBe(404);
    expect((await page.request.post("/api/auth/logout", { headers, data: {} })).ok()).toBe(true);
    expect((await page.request.get(`/api/businesses/${id}/planning`)).status()).toBe(401);
  } finally { if (organizationId) await db.organization.delete({ where: { id: organizationId } }); await db.user.deleteMany({ where: { email } }); }
});

test("mixed-media quantities and video rights consent save explicitly, reset in plan mode and remain keyboard accessible", async ({ page }) => {
  const email = `weekly-video-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Video Fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const created = await page.request.post("/api/businesses", { headers, data: { name: "Video Studio", offering: "Design consultations", audience: "Homeowners", goal: "Book consultations", channels: ["Instagram"] } });
    expect(created.ok()).toBe(true); const { id } = await created.json();
    organizationId = (await db.business.update({ where: { id }, data: { confirmedAt: new Date() } })).organizationId;
    await page.goto("/studio"); await page.getByRole("button", { name: "Workflows", exact: true }).click();
    const consent = page.getByRole("checkbox", { name: "Authorize video production after my scene approvals" });
    await expect(consent).toBeDisabled(); await expect(consent).not.toBeChecked();
    await page.getByRole("combobox", { name: "Weekly mode", exact: true }).selectOption("DRAFTS");
    await expect(consent).toBeDisabled(); await page.getByLabel("Maximum planned items", { exact: true }).fill("4");
    await page.getByLabel("Video items within this total", { exact: true }).fill("1");
    await expect(consent).toBeEnabled(); await consent.focus(); await page.keyboard.press("Space");
    await page.getByLabel("Weekly credit ceiling", { exact: true }).fill("100");
    await page.getByRole("button", { name: "Save recurring authorization" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Workflow settings saved" })).toBeVisible();
    expect(await db.weeklyPolicy.findUniqueOrThrow({ where: { businessId: id } })).toMatchObject({ enabled: false, videoItems: 1, videosAfterApproval: true, maxItems: 4, creditsPerWeek: 100 });
    await page.reload(); await page.getByRole("button", { name: "Workflows", exact: true }).click();
    await expect(consent).toBeChecked(); await expect(page.getByText("3 static creatives · 1 video concepts per week.", { exact: false })).toBeVisible();
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "../outputs/marketingbus-weekly-mixed-media.png", fullPage: true });
    await page.getByRole("combobox", { name: "Weekly mode", exact: true }).selectOption("PLAN"); await expect(consent).not.toBeChecked(); await expect(consent).toBeDisabled();
    await page.getByRole("button", { name: "Save recurring authorization" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Workflow settings saved" })).toBeVisible();
    expect(await db.weeklyPolicy.findUniqueOrThrow({ where: { businessId: id } })).toMatchObject({ mode: "PLAN", videosAfterApproval: false });
    expect(await db.videoGeneration.count({ where: { businessId: id } })).toBe(0);
  } finally { if (organizationId) await db.organization.delete({ where: { id: organizationId } }); await db.user.deleteMany({ where: { email } }); }
});

test("weekly image opt-in saves explicitly and pending media remains stoppable after copy authorization", async ({ page }) => {
  const email = `weekly-image-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Media Fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const created = await page.request.post("/api/businesses", { headers, data: { name: "Media Studio", offering: "Design consultations", audience: "Homeowners", goal: "Book consultations", channels: ["Facebook"] } });
    expect(created.ok()).toBe(true); const { id } = await created.json();
    const business = await db.business.update({ where: { id }, data: { confirmedAt: new Date() } }); organizationId = business.organizationId;
    await page.goto("/studio"); await page.getByRole("button", { name: "Workflows", exact: true }).click();
    await page.getByRole("checkbox", { name: "Enable recurring work for this business" }).check();
    await page.getByRole("combobox", { name: "Weekly mode", exact: true }).selectOption("DRAFTS");
    await page.getByRole("checkbox", { name: "Generate one image after I approve each weekly copy draft" }).check();
    await page.getByLabel("Weekly credit ceiling", { exact: true }).fill("20");
    await page.getByRole("button", { name: "Save recurring authorization" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Workflow settings saved" })).toBeVisible();
    expect(await db.weeklyPolicy.findUniqueOrThrow({ where: { businessId: id } })).toMatchObject({ imagesAfterApproval: true, creditsPerWeek: 20 });
    const plan = await db.productionPlan.create({ data: { organizationId, businessId: id, brandVersion: business.version, title: "Synthetic media phase", creditCeiling: 20, items: { create: { title: "Awaiting approved copy", format: "static", channel: "Facebook", brief: {} } } }, include: { items: true } });
    const cycle = await db.weeklyCycle.create({ data: { organizationId, businessId: id, planId: plan.id, brandVersion: business.version, policyVersion: 1, periodKey: "2026-10-12", status: "COMPLETE", mediaStatus: "OPEN", creditsAuthorized: 1, tasks: { create: { itemId: plan.items[0].id, status: "AUTHORIZED", imageStatus: "WAITING" } } } });
    await page.getByRole("button", { name: "Refresh weekly runs" }).click();
    await expect(page.getByText("Image: Waiting for approved copy", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Stop run for 2026-10-12", exact: true }).click();
    await page.getByRole("button", { name: "Confirm stop for 2026-10-12" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Weekly run stopped" })).toBeVisible();
    expect(await db.weeklyCycle.findUniqueOrThrow({ where: { id: cycle.id } })).toMatchObject({ status: "CANCELLED", mediaStatus: "CANCELLED", creditsAuthorized: 1 });
    expect(await db.imageGeneration.count({ where: { businessId: id } })).toBe(0);
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  } finally { if (organizationId) await db.organization.delete({ where: { id: organizationId } }); await db.user.deleteMany({ where: { email } }); }
});
