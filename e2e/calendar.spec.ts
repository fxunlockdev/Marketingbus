import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Requires explicit localhost fixture database.");
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Refusing non-local fixture writes");
const db = new PrismaClient();
test.afterAll(async () => db.$disconnect());
test.use({ timezoneId: "UTC" });
test("business calendar spans plans, confirms moves, rejects stale edits and preserves social posts", async ({ page }) => {
  test.setTimeout(60000);
  const browserSession = await page.context().newCDPSession(page);
  await browserSession.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const email = `calendar-browser-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Calendar fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const response = await page.request.post("/api/businesses", { headers, data: { name: "Calendar studio", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["Instagram"] } });
    const { id } = await response.json(); organizationId = (await db.business.findUniqueOrThrow({ where: { id } })).organizationId;
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } });
    const when = new Date(Date.now() + 3 * 86400000); when.setUTCHours(12, 0, 0, 0);
    const day = when.toISOString().slice(0, 10), month = day.slice(0, 7);
    const entries = [];
    for (const title of ["Earlier campaign", "Latest campaign"]) {
      const plan = await db.productionPlan.create({ data: { organizationId, businessId: id, title, brandVersion: 1, creditCeiling: 0,
        items: { create: { title: `${title} creative`, channel: "Instagram", format: "static", brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: { headline: "Considered homes", caption: "Architecture consultations for homeowners.", cta: "Meet us", visualDirection: "Original brand imagery", rationale: "Local fixture", evidenceUsed: [] } } } } },
      }, include: { items: { include: { revisions: true } } } });
      entries.push(await db.calendarEntry.create({ data: { organizationId, itemId: plan.items[0].id, revisionId: plan.items[0].revisions[0].id, scheduledFor: when, timezone: "UTC" } }));
    }
    const wallet = await db.wallet.findUnique({ where: { organizationId } });
    await page.goto("/studio"); await page.getByRole("button", { name: "Calendar", exact: true }).click();
    await page.getByLabel("Calendar month", { exact: true }).fill("");
    await expect(page.getByText("Choose a valid calendar date between 2000 and 2099.", { exact: true })).toBeVisible();
    await expect(page.locator(".business-calendar")).toHaveAttribute("aria-busy", "false");
    await page.getByLabel("Calendar month", { exact: true }).fill(month);
    for (const title of ["Earlier campaign creative", "Latest campaign creative"]) await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Calendar view", exact: true }).selectOption("week");
    await page.getByLabel("Week containing", { exact: true }).fill(day);
    await expect(page.getByRole("button", { name: `${day}, 2 reservations on this page`, exact: true })).toBeVisible();
    const moveButton = page.getByRole("button", { name: "Move Earlier campaign creative", exact: true });
    await moveButton.focus(); await page.keyboard.press("Enter");
    const dateInput = page.getByLabel(/New calendar date and time/);
    await expect(dateInput).toBeFocused(); await dateInput.fill(`${day}T13:00`);
    expect((await db.calendarEntry.findUniqueOrThrow({ where: { id: entries[0].id } })).version).toBe(1);
    await page.keyboard.press("Escape"); await expect(moveButton).toBeFocused();
    await moveButton.click(); await dateInput.fill(`${day}T13:00`);
    await page.getByRole("button", { name: "Confirm new calendar time", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Internal reservation updated" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh calendar", exact: true })).toBeFocused();
    expect(await db.calendarEntry.findUnique({ where: { id: entries[0].id } })).toMatchObject({ version: 2, scheduledFor: new Date(`${day}T13:00:00Z`) });
    // Dropping proposes a time; it never submits until confirmation.
    const target = page.getByRole("button", { name: `${day}, 2 reservations on this page`, exact: true });
    await page.locator(".calendar-agenda li").filter({ hasText: "Earlier campaign creative" }).dragTo(target);
    await expect(page.getByRole("heading", { name: "Move reservation: Earlier campaign creative", exact: true })).toBeVisible();
    expect((await db.calendarEntry.findUniqueOrThrow({ where: { id: entries[0].id } })).version).toBe(2);
    // A concurrent update cannot be overwritten by this open form.
    await db.calendarEntry.update({ where: { id: entries[0].id }, data: { version: { increment: 1 } } });
    await dateInput.fill(`${day}T14:00`); await page.getByRole("button", { name: "Confirm new calendar time", exact: true }).click();
    await expect(page.locator("#calendar-error")).toContainText("reservation changed");
    await expect(dateInput).toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "Cancel calendar change", exact: true }).click();
    const connection = await db.socialConnection.create({ data: { organizationId, businessId: id, provider: "Instagram", label: "Fixture only", externalAccountId: "fixture", encryptedToken: "not-a-real-token", permissions: [] } });
    const post = await db.socialPublication.create({ data: { organizationId, businessId: id, connectionId: connection.id, revisionId: entries[0].revisionId, brandVersion: 1, payload: {}, payloadHash: "fixture", scheduledFor: when, timezone: "UTC" } });
    await page.getByRole("button", { name: "Refresh calendar", exact: true }).click(); await expect(moveButton).toBeDisabled();
    await expect(page.getByRole("button", { name: "Remove Earlier campaign creative", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Remove Latest campaign creative", exact: true }).click();
    expect(await db.calendarEntry.count({ where: { organizationId } })).toBe(2);
    await page.getByRole("button", { name: "Confirm reservation removal", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Latest campaign creative", exact: true })).toHaveCount(0);
    expect(await db.socialPublication.findUnique({ where: { id: post.id } })).toEqual(post);
    expect(await db.wallet.findUnique({ where: { organizationId } })).toEqual(wallet);
    expect(await db.job.count({ where: { organizationId } })).toBe(0);
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "../outputs/marketingbus-calendar-mobile.png", fullPage: true });
    await db.membership.updateMany({ where: { organizationId }, data: { role: "VIEWER" } });
    expect((await page.request.post(`/api/businesses/${id}/production`, { headers, data: { action: "unschedule", itemId: entries[0].itemId, expectedCalendar: { id: entries[0].id, version: 3 } } })).status()).toBe(404);
    await page.request.post("/api/auth/logout", { headers, data: {} });
    const denied = await page.request.get(`/api/businesses/${id}/calendar`); expect(denied.status()).toBe(401); expect(denied.headers()["cache-control"]).toContain("no-store");
  } finally {
    if (organizationId) { await db.socialPublication.deleteMany({ where: { organizationId } }); await db.organization.delete({ where: { id: organizationId } }); }
    await db.user.deleteMany({ where: { email } });
  }
});
