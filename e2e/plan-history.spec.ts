import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Requires explicit localhost fixture database.");
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Refusing non-local fixture writes");
const db = new PrismaClient();
test.afterAll(async () => db.$disconnect());
test("earlier plans preserve selection through editing and superseded plans are read-only", async ({ page }) => {
  const email = `history-browser-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "History fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const response = await page.request.post("/api/businesses", { headers, data: { name: "History studio", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["Instagram"] } });
    const { id } = await response.json(); organizationId = (await db.business.findUniqueOrThrow({ where: { id } })).organizationId;
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } });
    const plans = [];
    for (const [index, title] of ["Archived week", "Earlier week", "Current week"].entries()) plans.push(await db.productionPlan.create({ data: {
      organizationId, businessId: id, title, brandVersion: 1, creditCeiling: 0, status: index === 0 ? "SUPERSEDED" : "PROPOSED", createdAt: new Date(2026, 0, index + 1),
      items: { create: { title: `${title} creative`, channel: "Instagram", format: "static", status: "READY", brief: {}, revisions: { create: { version: 1, status: "READY", content: { headline: `${title} headline`, caption: "Architecture consultations for homeowners.", cta: "Meet us", visualDirection: "Brand typography", rationale: "Local fixture", evidenceUsed: [] } } } } },
    }, include: { items: true } }));
    const endpoint = `/api/businesses/${id}/plans`;
    const history = await page.request.get(endpoint); expect(history.ok()).toBe(true); expect(history.headers()["cache-control"]).toContain("no-store");
    await page.goto("/studio"); await page.getByRole("button", { name: "Content plan", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Current week creative", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open Earlier week", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Earlier week creative", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Review inbox", exact: true }).click();
    await page.getByRole("button", { name: "Edit copy yourself · no credits" }).click();
    await page.getByLabel("Headline", { exact: true }).fill("Revised earlier headline");
    await page.getByRole("button", { name: "Save new copy version" }).click();
    await expect(page.getByRole("button", { name: "Approve version 2", exact: true })).toBeVisible();
    await expect(page.getByText("Revised earlier headline", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Video studio", exact: true }).click();
    await expect(page.getByLabel("Planned creative").getByRole("option", { name: /Earlier week creative/ })).toHaveCount(1);
    await expect(page.getByLabel("Planned creative").getByRole("option", { name: /Current week creative/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Content plan", exact: true }).click();
    await page.getByRole("button", { name: "Open Archived week", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Archived week headline" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit copy yourself · no credits" })).toHaveCount(0);
    const denied = await page.request.post(`/api/businesses/${id}/production`, { headers, data: { action: "approve", itemId: plans[0].items[0].id, version: 1 } }); expect(denied.status()).toBe(409);
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "../outputs/marketingbus-plan-history.png", fullPage: true });
    await page.getByRole("button", { name: "Return to latest plan", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Current week creative", exact: true })).toBeVisible();
    expect(await db.job.count({ where: { organizationId } })).toBe(0); expect(await db.reservation.count({ where: { organizationId } })).toBe(0);
  } finally {
    if (organizationId) await db.organization.delete({ where: { id: organizationId } });
    await db.user.deleteMany({ where: { email } });
  }
});
