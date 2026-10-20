import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { db } from "../src/lib/db";
import { manageBrandAnalysis } from "../src/lib/knowledge/analysis";
import { runOneBrandAnalysis } from "../src/lib/knowledge/analysis-worker";
import { heartbeat } from "../src/lib/production/readiness";
import path from "node:path";
import { createHash } from "node:crypto";

test("source-backed suggestions can be inspected, rejected and selectively applied to an unconfirmed draft", async ({ page, playwright }, testInfo) => {
  test.setTimeout(90000);
  test.skip(!process.env.TEST_DATABASE_URL, "Explicit local fixture database required");
  if (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["127.0.0.1", "localhost"].includes(new URL(process.env.TEST_DATABASE_URL!).hostname)) throw Error("Local fixture DB required");
  const headers = { Origin: "http://127.0.0.1:3000" }, email = `brand-browser-${crypto.randomUUID()}@example.test`;
  expect((await page.request.post("/api/auth/register", { headers, data: { name: "Review demo", email, password: "Fixture-only-password-2026!" } })).ok()).toBe(true);
  const businessResponse = await page.request.post("/api/businesses", { headers, data: { name: "Fieldwork Studio · demo business", offering: "Design consultations", audience: "Homeowners", goal: "Book consultations" } });
  expect(businessResponse.ok()).toBe(true); const { id: businessId } = await businessResponse.json();
  const sourceResponse = await page.request.post(`/api/businesses/${businessId}/sources`, { headers, data: { action: "document", title: "Business overview · demonstration evidence", text: "We design thoughtful homes around the people who live in them. Our voice is calm, precise and welcoming.", rightsConfirmed: true } });
  expect(sourceResponse.ok()).toBe(true); const { sourceId } = await sourceResponse.json();
  const user = await db.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const scope = { businessId, organizationId: user.memberships[0].organizationId, actorId: user.id }, workerId = `brand-browser-${user.id}`;
  const envKeys = ["OPENAI_API_KEY", "PAID_EXECUTION_ENABLED", "DAILY_SUPPLIER_BUDGET_MICROS", "TOTAL_SUPPLIER_BUDGET_MICROS", "REASONING_RATE_CARD_JSON"];
  const old = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  try {
    // Synthetic large imported page: never scrape or modify production data.
    const body = "We design thoughtful homes around the people who live in them. Our voice is calm, precise and welcoming.\n" + "Synthetic page details. ".repeat(2000);
    await db.knowledgeSource.update({ where: { id: sourceId }, data: { body, sha256: createHash("sha256").update(body).digest("hex") } });
    // Only this test process uses fixture settings. No mock provider is exposed by the web app.
    process.env.OPENAI_API_KEY = "fixture-never-network"; process.env.PAID_EXECUTION_ENABLED = "true";
    process.env.DAILY_SUPPLIER_BUDGET_MICROS = "50000000"; process.env.TOTAL_SUPPLIER_BUDGET_MICROS = "1000000000";
    process.env.REASONING_RATE_CARD_JSON = JSON.stringify([{ provider: "openai", model: "FIXTURE", lane: "creative", inputUsdPerMillion: 2, outputUsdPerMillion: 8, verifiedUntil: "2099-01-01T00:00:00Z" }]);
    await db.wallet.update({ where: { organizationId: scope.organizationId }, data: { available: 100 } }); await heartbeat(workerId);
    const q = await manageBrandAnalysis(scope, { action: "quote", sourceIds: [sourceId] }); if (!("analysisId" in q)) throw Error("Missing quote");
    await manageBrandAnalysis(scope, { action: "accept", analysisId: q.analysisId });
    const source = await db.knowledgeSource.findUniqueOrThrow({ where: { id: sourceId } });
    const offering = "We design thoughtful homes around the people who live in them.";
    await runOneBrandAnalysis(async (_provider, request) => {
      expect(Buffer.byteLength(JSON.parse(request.input).untrustedSources[0].body)).toBe(24000);
      return { id: "fixture-browser-response", usage: { input_tokens: 100, output_tokens: 100 }, text: JSON.stringify({ suggestions: [
      { field: "offering", kind: "EXACT_EXCERPT", value: offering, reason: "Your overview expresses a more distinctive, people-first offering than the current generic service description.", citations: [{ sourceId, sha256: source.sha256, excerpt: offering }] },
      { field: "tone", kind: "INFERRED_TONE", value: "Calm, precise and welcoming", reason: "A proposed writing preference drawn from your stated voice. Review it before using it across future content.", citations: [{ sourceId, sha256: source.sha256, excerpt: "Our voice is calm, precise and welcoming." }] },
    ] }) }; });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto("/studio"); await page.getByRole("button", { name: "Brand", exact: true }).click();
    await page.getByText("Photos, logos and documents", { exact: true }).click();
    const panel = page.getByRole("region", { name: "Evidence into direction." });
    await expect(panel.getByText("Ready for review", { exact: true })).toBeVisible();
    await panel.getByLabel("Business overview · demonstration evidence", { exact: true }).check();
    await expect(panel.getByText("1 selected · Opening excerpts will be used", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Get analysis quote", exact: true })).toBeEnabled();
    await panel.getByText("Inspect supporting evidence", { exact: true }).first().click();
    await expect(panel.locator("blockquote").first()).toHaveText(offering);
    expect((await new AxeBuilder({ page }).include(".intelligence-panel").analyze()).violations).toEqual([]);
    if (process.env.PROGRESS_SCREENSHOT_DIR) await panel.screenshot({ path: path.join(process.env.PROGRESS_SCREENSHOT_DIR, "brand-intelligence-review.png") });
    else await panel.screenshot({ path: testInfo.outputPath("brand-intelligence-review.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await panel.getByRole("button", { name: "Reject voice and tone", exact: true }).click();
    await expect(panel.getByText("Rejected", { exact: true })).toBeVisible();
    await panel.getByLabel("Apply offering", { exact: true }).check();
    await panel.getByRole("button", { name: "Apply selected to draft (1)", exact: true }).click();
    await expect(panel.getByText("Applied to draft", { exact: true })).toBeVisible();
    expect(await db.business.findUniqueOrThrow({ where: { id: businessId } })).toMatchObject({ offering, version: 2, confirmedAt: null, tone: "Clear and conversational" });
    const other = await playwright.request.newContext({ baseURL: "http://127.0.0.1:3000" });
    try {
      await other.post("/api/auth/register", { headers, data: { name: "Other workspace", email: `brand-other-${crypto.randomUUID()}@example.test`, password: "Fixture-only-password-2026!" } });
      expect((await other.get(`/api/businesses/${businessId}/intelligence`)).status()).toBe(404);
      expect((await other.post(`/api/businesses/${businessId}/intelligence`, { headers, data: { action: "apply", analysisId: q.analysisId, fields: ["offering"], version: 1 } })).status()).toBe(404);
    } finally { await other.dispose(); }
    await page.request.post(`/api/businesses/${businessId}/sources`, { headers, data: { action: "delete", sourceId } });
    await panel.getByRole("button", { name: "Refresh suggestions" }).click();
    await expect(panel.getByText("Proposed replacement", { exact: true })).toHaveCount(0);
  } finally {
    const rows = await db.brandAnalysis.findMany({ where: { businessId }, select: { id: true } });
    await db.supplierAuthorization.deleteMany({ where: { key: { in: rows.map(r => r.id) } } });
    await db.workerHeartbeat.deleteMany({ where: { id: workerId } });
    await db.organization.deleteMany({ where: { id: scope.organizationId } }); await db.user.delete({ where: { id: user.id } });
    for (const key of envKeys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
    await db.$disconnect();
  }
});
