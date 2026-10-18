import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Requires explicit localhost fixture database.");
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Refusing non-local fixture writes");
const db = new PrismaClient();
test.afterAll(async () => db.$disconnect());
test("verified Facebook receipt is visible without fabricated performance or exposed submission context", async ({ page }) => {
  const email = `facebook-receipt-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Receipt fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const response = await page.request.post("/api/businesses", { headers, data: { name: "Receipt studio", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["Facebook"] } });
    const { id } = await response.json(); organizationId = (await db.business.findUniqueOrThrow({ where: { id } })).organizationId;
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "plan", version: 1 } });
    const item = await db.productionItem.findFirstOrThrow({ where: { plan: { businessId: id } } });
    const revision = await db.creativeRevision.create({ data: { itemId: item.id, organizationId, version: 1, status: "APPROVED", content: { headline: "Considered spaces", caption: "Architecture consultations for homeowners.", cta: "Meet us", visualDirection: "Brand typography", rationale: "Local fixture", evidenceUsed: [] } } });
    const connection = await db.socialConnection.create({ data: { businessId: id, organizationId, provider: "Facebook", externalAccountId: "789", label: "Fixture page", encryptedToken: "fixture-never-use-or-return", permissions: [] } });
    // Local display fixture only. Real adapter/worker receipt verification is covered in database tests.
    await db.socialPublication.create({ data: { businessId: id, organizationId, connectionId: connection.id, revisionId: revision.id, brandVersion: 1, payload: { privateFixture: "not-for-browser" }, payloadHash: "private-fixture-hash", status: "PUBLISHED", scheduledFor: new Date(), publishedAt: new Date(), timezone: "UTC", externalPostId: "789_123", candidatePostId: "789_123", submissionAdapterVersion: "private-adapter-version", permalink: "https://www.facebook.com/789/posts/123", nextMetricsAt: null } });
    const result = await page.request.get(`/api/businesses/${id}/social`), body = await result.text();
    expect(result.ok()).toBe(true); expect(result.headers()["cache-control"]).toContain("no-store");
    for (const hidden of ["encryptedToken", "fixture-never-use-or-return", "not-for-browser", "private-fixture-hash", "candidatePostId", "submissionAdapterVersion", "private-adapter-version"]) expect(body).not.toContain(hidden);
    await page.goto("/studio"); await page.getByRole("button", { name: "Publishing & analytics", exact: true }).click();
    await expect(page.getByText("Provider post ID: 789_123", { exact: true })).toBeVisible();
    const link = page.getByRole("link", { name: "View published post" });
    await expect(link).toHaveAttribute("href", "https://www.facebook.com/789/posts/123");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.getByText(/Not yet observed/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel publication", exact: true })).toHaveCount(0);
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await db.metricSnapshot.count({ where: { businessId: id } })).toBe(0);
  } finally {
    if (organizationId) { await db.socialPublication.deleteMany({ where: { organizationId } }); await db.organization.delete({ where: { id: organizationId } }); }
    await db.user.deleteMany({ where: { email } });
  }
});
test("unconfirmed publication stays on hold and exposes no retry or forged receipt path", async ({ page, browser }) => {
  const email = `social-recovery-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Social recovery fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const response = await page.request.post("/api/businesses", { headers, data: { name: "Recovery studio", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["Facebook"] } });
    const { id } = await response.json(); organizationId = (await db.business.findUniqueOrThrow({ where: { id } })).organizationId;
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "plan", version: 1 } });
    const item = await db.productionItem.findFirstOrThrow({ where: { plan: { businessId: id } } });
    const revision = await db.creativeRevision.create({ data: { itemId: item.id, organizationId, version: 1, status: "APPROVED", content: { headline: "Considered spaces", caption: "Architecture consultations for homeowners.", cta: "Meet us", visualDirection: "Brand typography", rationale: "Local fixture", evidenceUsed: [] } } });
    const connection = await db.socialConnection.create({ data: { businessId: id, organizationId, provider: "Facebook", externalAccountId: "local-only-account", label: "Fixture page", encryptedToken: "fixture-never-use-or-return", permissions: [] } });
    const post = await db.socialPublication.create({ data: { businessId: id, organizationId, connectionId: connection.id, revisionId: revision.id, brandVersion: 1, payload: { privateFixture: "not-for-browser" }, payloadHash: "private-fixture-hash", status: "NEEDS_RECONCILIATION", scheduledFor: new Date(), timezone: "UTC", reconciliationAttempts: 5, errorCode: "PUBLICATION_NOT_CONFIRMED" } });
    const endpoint = `/api/businesses/${id}/social`, state = await page.request.get(endpoint), body = await state.text();
    expect(state.ok()).toBe(true); expect(state.headers()["cache-control"]).toContain("no-store");
    for (const hidden of ["encryptedToken", "fixture-never-use-or-return", "not-for-browser", "private-fixture-hash"]) expect(body).not.toContain(hidden);
    await page.goto("/studio"); await page.getByRole("button", { name: "Publishing & analytics", exact: true }).click();
    await expect(page.getByText("Publication is unconfirmed. This post will not be sent again automatically.")).toBeVisible();
    await expect(page.getByText(/Lookup checks: 5.*Operator review is required/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel publication", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "View published post" })).toHaveCount(0);
    const cancel = await page.request.post(endpoint, { headers, data: { action: "cancel", publicationId: post.id } }); expect(cancel.status()).toBe(409);
    const forged = await page.request.post(endpoint, { headers, data: { action: "reconcile", publicationId: post.id, externalPostId: "invented" } }); expect(forged.status()).toBe(400);
    await db.membership.updateMany({ where: { organizationId }, data: { role: "VIEWER" } });
    expect((await page.request.get(endpoint)).ok()).toBe(true);
    expect((await page.request.post(endpoint, { headers, data: { action: "cancel", publicationId: post.id } })).status()).toBe(404);
    const anonymous = await browser.newContext();
    try { expect((await anonymous.request.get(`http://127.0.0.1:3000${endpoint}`)).status()).toBe(401); } finally { await anonymous.close(); }
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("article").filter({ hasText: "Publication is unconfirmed" }).screenshot({ path: "../outputs/marketingbus-social-recovery-status.png" });
    expect(await db.socialPublication.findUnique({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", externalPostId: null, reconciliationAttempts: 5 });
    expect(await db.job.count({ where: { organizationId } })).toBe(0);
  } finally {
    if (organizationId) { await db.socialPublication.deleteMany({ where: { organizationId } }); await db.organization.delete({ where: { id: organizationId } }); }
    await db.user.deleteMany({ where: { email } });
  }
});
