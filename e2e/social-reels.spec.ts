import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { db } from "../src/lib/db";
import { manageVideo } from "../src/lib/video/service";
import { storyboardDocument, totalDuration } from "../src/lib/video/document";
import { motionHash, MOTION_RENDERER_VERSION } from "../src/lib/video/limits";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Requires explicit localhost fixture database.");
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Refusing non-local fixture writes");
test.afterAll(async () => db.$disconnect());
for (const provider of ["Instagram", "Facebook"]) test(`${provider} approved Reel selection is accessible, exact-version scoped and fails closed without activation`, async ({ page, browser }) => {
  const email = `reel-ui-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Reel fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const response = await page.request.post("/api/businesses", { headers, data: { name: "Design studio", offering: "Design consultations", audience: "Homeowners", goal: "Book consultations", channels: [provider] } });
    const { id } = await response.json(); organizationId = (await db.business.findUniqueOrThrow({ where: { id } })).organizationId;
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "plan", version: 1 } });
    const user = await db.user.findUniqueOrThrow({ where: { email } }), scope = { businessId: id, organizationId, actorId: user.id };
    const plan = await db.productionPlan.findFirstOrThrow({ where: { businessId: id } });
    const item = await db.productionItem.findFirstOrThrow({ where: { planId: plan.id, channel: provider, format: "static" } });
    await db.creativeRevision.create({ data: { itemId: item.id, organizationId, version: 1, status: "APPROVED", content: { headline: "Considered spaces", caption: "Design consultations for homeowners.", cta: "Meet us", visualDirection: "Brand typography", rationale: "Local fixture", evidenceUsed: [] } } });
    const storyboardId = (await manageVideo(scope, { action: "create", itemId: item.id })).storyboardId!;
    const document = storyboardDocument.parse((await db.videoStoryboard.findUniqueOrThrow({ where: { id: storyboardId } })).document);
    for (const shot of document.shots) await manageVideo(scope, { action: "review-shot", storyboardId, shotId: shot.id, approved: true });
    await manageVideo(scope, { action: "approve-storyboard", storyboardId });
    // Metadata-only UI fixture; playable generation/delivery is verified in the DB integration suite.
    const render = await db.motionRender.create({ data: { organizationId, businessId: id, storyboardId, rendererVersion: MOTION_RENDERER_VERSION, documentHash: motionHash(document), objectKey: "private-ui-fixture/not-downloadable.mp4", sha256: "a".repeat(64), bytes: 1024, durationMs: totalDuration(document), status: "APPROVED", createdBy: user.id, approvedBy: user.id, purgeAfter: new Date(Date.now() + 86400000) } });
    const connection = await db.socialConnection.create({ data: { organizationId, businessId: id, provider, externalAccountId: "987", label: "Design company", encryptedToken: "never-return-this-fixture", permissions: [], expiresAt: new Date(Date.now() + 3600000) } });
    const endpoint = `/api/businesses/${id}/social`, actual = await (await page.request.get(endpoint)).json();
    expect(actual.videoProviders).toEqual([]);
    expect(actual.videoChoices).toEqual([expect.objectContaining({ id: render.id, itemId: item.id, revisionVersion: 1, durationMs: 13000 })]);
    for (const secret of ["objectKey", "encryptedToken", "private-ui-fixture", "never-return-this-fixture"]) expect(JSON.stringify(actual)).not.toContain(secret);
    await page.goto("/studio"); await page.getByRole("button", { name: "Publishing & analytics", exact: true }).click();
    await page.getByLabel("Approved creative", { exact: true }).selectOption(item.id);
    await page.getByLabel("Publishing media", { exact: true }).selectOption("video");
    await expect(page.getByLabel("Approved final video", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Approved image export", { exact: true })).toHaveCount(0);
    await expect(page.locator("#social-video-help")).toContainText("not activated");
    await page.route(`**${endpoint}`, async route => {
      if (route.request().method() !== "GET") return route.continue();
      const result = await route.fetch(), data = await result.json();
      await route.fulfill({ response: result, json: { ...data, enabledProviders: [provider], videoProviders: [provider] } });
    });
    await page.reload(); await page.getByRole("button", { name: "Publishing & analytics", exact: true }).click();
    await page.getByLabel("Approved creative", { exact: true }).selectOption(item.id);
    await page.getByLabel("Publishing media", { exact: true }).selectOption("video");
    await page.getByLabel("Approved final video", { exact: true }).selectOption(render.id);
    const feed = page.getByRole("checkbox", { name: "Also share this Reel to the Instagram feed" });
    if (provider === "Instagram") { await expect(feed).not.toBeChecked(); await feed.focus(); await page.keyboard.press("Space"); await expect(feed).toBeChecked(); }
    else { await expect(feed).toHaveCount(0); await expect(page.locator("#social-video-help")).toContainText("4–30 seconds"); await expect(page.locator("#social-video-help")).toContainText("uploaded directly"); }
    await expect(page.getByRole("link", { name: "Download selected approved video" })).toHaveAttribute("href", `/api/businesses/${id}/video/${render.id}?download=true`);
    await page.getByLabel("Destination account", { exact: true }).selectOption(connection.id);
    await page.getByLabel("Publish at (your local timezone)", { exact: true }).fill("2026-11-01T12:00");
    const failed = page.waitForResponse(r => r.url().endsWith(endpoint) && r.request().method() === "POST");
    await page.getByRole("button", { name: "Schedule social publication", exact: true }).focus(); await page.keyboard.press("Enter");
    const submitted = await failed; expect(submitted.status()).toBe(503);
    expect(submitted.request().postDataJSON()).toMatchObject({ videoRenderId: render.id, itemId: item.id, version: 1 });
    if (provider === "Instagram") expect(submitted.request().postDataJSON()).toHaveProperty("shareToFeed", true);
    else expect(submitted.request().postDataJSON()).not.toHaveProperty("shareToFeed");
    expect(submitted.request().postDataJSON()).not.toHaveProperty("mediaExportId");
    const alert = page.getByRole("main").getByRole("alert"); await expect(alert).toContainText("not connected"); await expect(alert).toBeFocused();
    expect(await db.socialPublication.count({ where: { businessId: id } })).toBe(0);
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel("Approved creative", { exact: true }).selectOption("");
    await page.getByLabel("Approved creative", { exact: true }).selectOption(item.id);
    await expect(page.getByLabel("Publishing media", { exact: true })).toHaveValue("image");
    await page.getByLabel("Publishing media", { exact: true }).selectOption("video");
    await expect(page.getByLabel("Approved final video", { exact: true })).toHaveValue("");
    if (provider === "Instagram") await expect(feed).not.toBeChecked(); else await expect(feed).toHaveCount(0);
    await db.membership.updateMany({ where: { organizationId }, data: { role: "VIEWER" } });
    expect((await page.request.post(endpoint, { headers, data: { action: "schedule", itemId: item.id, version: 1, connectionId: connection.id, videoRenderId: render.id, scheduledFor: new Date(Date.now() + 120000).toISOString(), timezone: "UTC" } })).status()).toBe(404);
    const anonymous = await browser.newContext();
    try { expect((await anonymous.request.get(`http://127.0.0.1:3000${endpoint}`)).status()).toBe(401); } finally { await anonymous.close(); }
  } finally {
    if (organizationId) { await db.socialPublication.deleteMany({ where: { organizationId } }); await db.motionRender.deleteMany({ where: { organizationId } }); await db.videoStoryboard.deleteMany({ where: { organizationId } }); await db.organization.delete({ where: { id: organizationId } }); }
    await db.user.deleteMany({ where: { email } });
  }
});
