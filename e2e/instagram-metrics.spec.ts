import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Requires explicit localhost fixture database.");
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Refusing non-local fixture writes");
const db = new PrismaClient();
test.afterAll(async () => db.$disconnect());
for (const kind of ["feed", "reel"] as const) test(`Instagram ${kind} views stay distinct from unavailable impressions and edited-post evidence`, async ({ page, browser }) => {
  const email = `instagram-metrics-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Metric display fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const response = await page.request.post("/api/businesses", { headers, data: { name: "Northline metrics", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["Instagram"] } });
    const { id } = await response.json(); organizationId = (await db.business.findUniqueOrThrow({ where: { id } })).organizationId;
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "plan", version: 1 } });
    const item = await db.productionItem.findFirstOrThrow({ where: { plan: { businessId: id } } });
    const revision = await db.creativeRevision.create({ data: { itemId: item.id, organizationId, version: 1, status: "APPROVED", content: { headline: "Considered spaces", caption: "Architecture consultations for homeowners.", cta: "Meet us", visualDirection: "Brand typography", rationale: "Local fixture", evidenceUsed: [] } } });
    const connection = await db.socialConnection.create({ data: { businessId: id, organizationId, provider: "Instagram", externalAccountId: "987", label: "Fixture Instagram account", encryptedToken: "fixture-never-use-or-return", permissions: [] } });
    // Display-only fixture; real reader/worker/receipt ingestion has separate database acceptance.
    const payload = { caption: "Architecture consultations for homeowners.", channel: "Instagram", format: kind === "reel" ? "video" : "static", mediaExportId: "private-fixture-export", ...(kind === "reel" ? { video: { sha256: "a".repeat(64), bytes: 1000, width: 720, height: 1280, durationMs: 6000, shareToFeed: false } } : { image: { sha256: "b".repeat(64), bytes: 1000, width: 1080, height: 1080, altText: "Considered spaces" } }) };
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const post = await db.socialPublication.create({ data: { businessId: id, organizationId, connectionId: connection.id, revisionId: revision.id, brandVersion: 1, payload, payloadHash: hash, status: "PUBLISHED", scheduledFor: new Date(), publishedAt: new Date(), timezone: "UTC", externalPostId: "1234567", nextMetricsAt: null, metrics: { create: { observedAt: new Date(), definitionVersion: `instagram-${kind}-views-reach-total-interactions-v26.0-v1`, views: 1234, reach: 0, engagements: 50 } } } });
    const endpoint = `/api/businesses/${id}/social`, responseBody = await page.request.get(endpoint), body = await responseBody.text();
    expect(responseBody.headers()["cache-control"]).toContain("no-store");
    for (const secret of ["fixture-never-use-or-return", "private-fixture-export", hash]) expect(body).not.toContain(secret);
    expect((await responseBody.json()).enabledVideoMetricProviders).toEqual([]);
    await page.goto("/studio"); await page.getByRole("button", { name: "Publishing & analytics", exact: true }).click();
    const table = page.getByRole("table", { name: "Available lifetime metrics and coverage" });
    await expect(table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Views (not impressions)", exact: true }) })).toContainText("1,234");
    await expect(table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "impressions", exact: true }) })).toContainText("Unavailable");
    await expect(table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "reach", exact: true }) }).getByRole("cell").first()).toHaveText("0");
    await expect(page.getByText(/these readings do not meet the impression-based learning policy/)).toBeVisible();
    if (kind === "reel") {
      await expect(page.getByText(/Reel metric collection is not enabled/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Resume metric checks" })).toHaveCount(0);
      // Browser capability fixture only. The real recovery endpoint must still reject execution.
      await page.route(`**${endpoint}`, async route => {
        const response = await route.fetch(), data = await response.json();
        await route.fulfill({ response, json: { ...data, enabledMetricProviders: [], enabledVideoMetricProviders: ["Instagram"] } });
      });
      await page.reload(); await page.getByRole("button", { name: "Publishing & analytics", exact: true }).click();
      const resume = page.getByRole("button", { name: "Resume metric checks" });
      await resume.focus(); page.once("dialog", dialog => dialog.dismiss()); await page.keyboard.press("Enter");
      expect(await db.auditEvent.count({ where: { businessId: id, action: "SOCIAL_METRICS_RESUMED" } })).toBe(0);
      page.once("dialog", dialog => dialog.accept());
      const denied = page.waitForResponse(r => r.url().endsWith(`${endpoint}/metrics`) && r.request().method() === "POST");
      await resume.press("Enter"); expect((await denied).status()).toBe(503);
      await expect(page.getByText(/Verified post metrics are not enabled for this destination yet/)).toBeVisible();
      await page.unroute(`**${endpoint}`);
    }
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await db.socialPublication.update({ where: { id: post.id }, data: { metricsInvalidatedAt: new Date(), errorCode: "METRICS_SOURCE_CHANGED" } });
    await page.reload(); await page.getByRole("button", { name: "Publishing & analytics", exact: true }).click();
    await expect(page.getByText(/Metrics excluded: the published creative/)).toBeVisible();
    await expect(table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Views (not impressions)", exact: true }) })).toContainText("Unavailable");
    expect(await db.metricSnapshot.count({ where: { publicationId: post.id } })).toBe(1);
    const anonymous = await browser.newContext();
    try { expect((await anonymous.request.get(`http://127.0.0.1:3000${endpoint}`)).status()).toBe(401); } finally { await anonymous.close(); }
    expect(await db.reservation.count({ where: { organizationId } })).toBe(0);
  } finally {
    if (organizationId) { await db.socialPublication.deleteMany({ where: { organizationId } }); await db.organization.delete({ where: { id: organizationId } }); }
    await db.user.deleteMany({ where: { email } });
  }
});
