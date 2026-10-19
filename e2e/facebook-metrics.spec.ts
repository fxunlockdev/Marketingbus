import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Requires explicit localhost fixture database.");
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Refusing non-local fixture writes");
const db = new PrismaClient();
test.afterAll(async () => db.$disconnect());
test("Facebook native metrics preserve meaning, access boundaries and edited-post exclusions", async ({ page, browser }) => {
  const email = `facebook-metrics-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Metric display fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const response = await page.request.post("/api/businesses", { headers, data: { name: "Northline Facebook metrics", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["Facebook"] } });
    const { id } = await response.json(); organizationId = (await db.business.findUniqueOrThrow({ where: { id } })).organizationId;
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "plan", version: 1 } });
    const item = await db.productionItem.findFirstOrThrow({ where: { plan: { businessId: id } } });
    const revision = await db.creativeRevision.create({ data: { itemId: item.id, organizationId, version: 1, status: "APPROVED", content: { headline: "Considered spaces", caption: "Architecture consultations for homeowners.", cta: "Meet us", visualDirection: "Brand typography", rationale: "Local fixture", evidenceUsed: [] } } });
    const connection = await db.socialConnection.create({ data: { businessId: id, organizationId, provider: "Facebook", externalAccountId: "789", label: "Fixture Facebook Page", encryptedToken: "fixture-never-use-or-return", permissions: [] } });
    // Display-only fixture. The real adapter's HTTP-to-worker path is covered separately.
    const post = await db.socialPublication.create({ data: { businessId: id, organizationId, connectionId: connection.id, revisionId: revision.id, brandVersion: 1, payload: { privateFixture: "not-for-browser" }, payloadHash: "private-fixture-hash", status: "PUBLISHED", scheduledFor: new Date(), publishedAt: new Date(), timezone: "UTC", externalPostId: "789_123", nextMetricsAt: null, metrics: { create: { observedAt: new Date(), definitionVersion: "facebook-post-views-unique-clicks-reactions-v26.0-v1", views: 1234, uniqueViewers: 800, reactions: 0, clicks: null } } } });
    const endpoint = `/api/businesses/${id}/social`, result = await page.request.get(endpoint), body = await result.text();
    expect(result.headers()["cache-control"]).toContain("no-store");
    for (const secret of ["fixture-never-use-or-return", "not-for-browser", "private-fixture-hash"]) expect(body).not.toContain(secret);
    await page.goto("/studio"); await page.getByRole("button", { name: "Publishing & analytics", exact: true }).click();
    const table = page.getByRole("table", { name: "Available lifetime metrics and coverage" });
    const value = (name: string) => table.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) }).getByRole("cell").first();
    await expect(value("Views (not impressions)")).toHaveText("1,234"); await expect(value("Unique viewers per post")).toHaveText("800");
    await expect(value("Reactions (not total engagement)")).toHaveText("0");
    for (const name of ["impressions", "reach", "engagements", "clicks"]) await expect(value(name)).toHaveText("Unavailable");
    await expect(page.getByText(/unique viewers are summed per post, not a deduplicated audience/)).toBeVisible();
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await db.socialPublication.update({ where: { id: post.id }, data: { metricsInvalidatedAt: new Date(), errorCode: "METRICS_SOURCE_CHANGED" } });
    await page.reload(); await page.getByRole("button", { name: "Publishing & analytics", exact: true }).click();
    await expect(page.getByText(/Metrics excluded: the published creative/)).toBeVisible(); await expect(value("Unique viewers per post")).toHaveText("Unavailable");
    expect(await db.metricSnapshot.count({ where: { publicationId: post.id } })).toBe(1);
    const anonymous = await browser.newContext(); try { expect((await anonymous.request.get(`http://127.0.0.1:3000${endpoint}`)).status()).toBe(401); } finally { await anonymous.close(); }
    expect(await db.reservation.count({ where: { organizationId } })).toBe(0);
  } finally {
    if (organizationId) { await db.socialPublication.deleteMany({ where: { organizationId } }); await db.organization.delete({ where: { id: organizationId } }); }
    await db.user.deleteMany({ where: { email } });
  }
});
