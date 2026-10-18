import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { storyboardDocument } from "../src/lib/video/document";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Requires localhost fixture database.");
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Local fixtures only");
const db = new PrismaClient();
test.afterAll(async () => db.$disconnect());
test("generated-shot status protects quotes and uncertain jobs without exposing operator credentials", async ({ page }) => {
  const email = `shot-ui-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" }; let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Shot fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const r = await page.request.post("/api/businesses", { headers, data: { name: "Shot studio", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["YouTube"] } });
    const { id } = await r.json(), business = await db.business.findUniqueOrThrow({ where: { id } }); organizationId = business.organizationId;
    const actor = await db.user.findUniqueOrThrow({ where: { email } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "plan", version: 1 } });
    const item = await db.productionItem.findFirstOrThrow({ where: { plan: { businessId: id } } });
    const created = await page.request.post(`/api/businesses/${id}/video`, { headers, data: { action: "create", itemId: item.id } }); const { storyboardId } = await created.json();
    const board = await db.videoStoryboard.findUniqueOrThrow({ where: { id: storyboardId } });
    const document = storyboardDocument.parse(board.document);
    for (const shot of document.shots) expect((await page.request.post(`/api/businesses/${id}/video`, { headers, data: { action: "review-shot", storyboardId, shotId: shot.id, approved: true } })).ok()).toBe(true);
    expect((await page.request.post(`/api/businesses/${id}/video`, { headers, data: { action: "approve-storyboard", storyboardId } })).ok()).toBe(true);
    const base = { businessId: id, organizationId, actorId: actor.id, storyboardId, itemId: item.id, brandVersion: 1, shotId: "fixture", documentHash: "fixture", prompt: "PRIVATE PROMPT MUST STAY SERVER SIDE", configurationHash: "private-configuration", durationMs: 5000, credits: 10, supplierCeilingMicros: 100000, route: { privateOperatorKey: "never-display" }, expiresAt: new Date(Date.now() + 600000) };
    // Controlled local states, not a live supplier run. No fixture transport enters the app.
    const offered = await db.videoGeneration.create({ data: { ...base, shotLabel: "Unaccepted quote" } });
    const original = await db.videoGeneration.create({ data: { ...base, copyRevisionId: board.copyRevisionId, shotId: document.shots[0].id, documentHash: createHash("sha256").update(JSON.stringify(document)).digest("hex"), shotLabel: "Soft-light original", status: "READY", creativeBrief: { version: 1, direction: "Warm side lighting with a slow architectural dolly.", revisions: [] } } });
    await db.videoClip.create({ data: { generationId: original.id, businessId: id, organizationId, brandVersion: 1, label: "Local metadata fixture only", createdBy: actor.id, rightsConfirmedAt: new Date(), status: "READY", sourceKey: `${id}/fixture-source`, sourceHash: "a".repeat(64), sourceBytes: 100, objectKey: `${id}/fixture-output`, sha256: "b".repeat(64), bytes: 100, durationMs: 5000, processorVersion: "local-fixture", purgeAfter: new Date(Date.now() + 86400000) } });
    const uncertain = await db.videoGeneration.create({ data: { ...base, shotLabel: "Uncertain supplier request", status: "NEEDS_RECONCILIATION", acceptedAt: new Date(), providerJobId: "private-supplier-job", receipt: { evidence: "PRIVATE RECEIPT" } } });
    const hold = await db.reservation.create({ data: { organizationId, key: `${organizationId}:${uncertain.id}`, credits: 10, purpose: "INITIAL" } });
    await db.wallet.update({ where: { organizationId }, data: { available: 90, held: 10 } });
    await db.videoGeneration.update({ where: { id: uncertain.id }, data: { reservationId: hold.id } });
    await page.goto("/studio"); await page.getByRole("button", { name: "Video studio", exact: true }).click();
    await page.getByLabel("Planned creative").selectOption(item.id); await page.getByRole("button", { name: "Create or open storyboard" }).click();
    const panel = page.getByRole("region", { name: "Generated shot production" });
    await expect(panel.getByText("Generated video is awaiting a verified provider integration.", { exact: false })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Get shot quote · no charge" })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Reserve 10 credits · Unaccepted quote" })).toBeDisabled();
    await expect(panel.getByText("Outcome uncertain · hold retained for operator review", { exact: false })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Cancel generation · Uncertain supplier request" })).toHaveCount(0);
    for (const secret of ["PRIVATE PROMPT", "PRIVATE RECEIPT", "private-supplier-job", "never-display"]) await expect(panel).not.toContainText(secret);
    const projection = JSON.stringify(await (await page.request.get(`/api/businesses/${id}/video-generations`)).json());
    for (const secret of ["prompt", "route", "receipt", "supplierCeilingMicros", "providerJobId"]) expect(projection).not.toContain(secret);
    expect((await page.request.post(`/api/businesses/${id}/video-generations`, { headers, data: { action: "cancel", generationId: uncertain.id } })).status()).toBe(409);
    await panel.getByRole("button", { name: "Cancel generation · Unaccepted quote" }).click();
    await expect(panel.getByText("Cancelled before submission", { exact: false })).toBeVisible();
    expect((await db.videoGeneration.findUniqueOrThrow({ where: { id: offered.id } })).status).toBe("CANCELLED");
    expect(await db.reservation.count({ where: { organizationId } })).toBe(1);
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId } })).toMatchObject({ available: 90, held: 10 });
    await panel.getByLabel("Approved scene for generation").selectOption(document.shots[0].id);
    await panel.getByLabel("Visual direction (optional)").fill("Soft light and restrained movement.");
    await panel.getByLabel("Generation approach").selectOption(original.id);
    await expect(panel.getByText("Retained direction: Warm side lighting with a slow architectural dolly.")).toBeVisible();
    await panel.getByLabel("Feedback for this take").fill("Keep the warm light, but use a much slower dolly.");
    await expect(panel.getByRole("button", { name: "Get new-take quote · no charge" })).toBeDisabled();
    // UI-only capability fixture allows exercising the form; the real server still refuses unconfigured providers.
    await page.route(`**/api/businesses/${id}/video-generations`, async route => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch(), data = await response.json();
      await route.fulfill({ response, json: { ...data, integrationAvailable: true } });
    });
    await panel.getByRole("button", { name: "Refresh generated-shot status" }).click();
    await expect(panel).toHaveAttribute("aria-busy", "false");
    await expect(panel.getByRole("status")).toBeFocused();
    await expect(panel.getByRole("button", { name: "Get new-take quote · no charge" })).toBeEnabled();
    const posted = page.waitForRequest(r => r.url().endsWith(`/api/businesses/${id}/video-generations`) && r.method() === "POST");
    await panel.getByRole("button", { name: "Get new-take quote · no charge" }).focus();
    await expect(panel.getByRole("button", { name: "Get new-take quote · no charge" })).toBeFocused(); await page.keyboard.press("Enter");
    expect((await posted).postDataJSON()).toEqual({ action: "quote", storyboardId, shotId: document.shots[0].id, revisionOfId: original.id, feedback: "Keep the warm light, but use a much slower dolly." });
    await expect(panel.getByRole("alert")).toContainText("verified provider");
    await expect(panel.getByRole("alert")).toBeFocused();
    await expect(panel.getByLabel("Feedback for this take")).toHaveValue("Keep the warm light, but use a much slower dolly.");
    expect(await db.videoGeneration.count({ where: { organizationId } })).toBe(3);
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId } })).toMatchObject({ available: 90, held: 10 });
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await panel.screenshot({ path: "../outputs/marketingbus-generated-shot-jobs.png" });
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await db.membership.update({ where: { organizationId_userId: { organizationId, userId: actor.id } }, data: { role: "VIEWER" } });
    expect((await page.request.post(`/api/businesses/${id}/video-generations`, { headers, data: { action: "cancel", generationId: uncertain.id } })).status()).toBe(404);
    expect((await page.request.get("/api/businesses/another-business/video-generations")).status()).toBe(404);
    await page.context().clearCookies(); expect((await page.request.get(`/api/businesses/${id}/video-generations`)).status()).toBe(401);
  } finally {
    if (organizationId) { await db.videoClip.deleteMany({ where: { organizationId } }); await db.videoGeneration.deleteMany({ where: { organizationId } }); await db.videoStoryboard.deleteMany({ where: { organizationId } }); await db.organization.delete({ where: { id: organizationId } }); }
    await db.user.deleteMany({ where: { email } });
  }
});
