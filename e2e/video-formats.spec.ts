import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { renderMotion } from "../src/lib/video/render";
import { storyboardDocument } from "../src/lib/video/document";
import { MOTION_RENDERER_VERSION, motionHash } from "../src/lib/video/limits";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local || !process.env.TEST_FFMPEG_PATH || !process.env.TEST_FFPROBE_PATH, "Requires explicit local DB and encoder paths.");
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Refusing non-local fixture writes");
const db = new PrismaClient();
test.afterAll(async () => db.$disconnect());
test("format changes require fresh review and export real landscape media with format-bound captions", async ({ page }) => {
  test.setTimeout(90000);
  const email = `format-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  const previous = { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Video format fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const { id } = await (await page.request.post("/api/businesses", { headers, data: { name: "Format studio", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["YouTube"] } })).json();
    organizationId = (await db.business.findUniqueOrThrow({ where: { id } })).organizationId;
    const actor = await db.user.findUniqueOrThrow({ where: { email } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "plan", version: 1 } });
    const item = await db.productionItem.findFirstOrThrow({ where: { plan: { businessId: id } } }), endpoint = `/api/businesses/${id}/video`;
    await page.goto("/studio"); await page.getByRole("button", { name: "Video studio", exact: true }).click();
    await page.getByLabel("Planned creative").selectOption(item.id); await page.getByRole("button", { name: "Create or open storyboard" }).click();
    const format = page.getByRole("combobox", { name: "Video format", exact: true });
    await expect(format).toHaveValue("portrait"); await expect(format.locator("option")).toHaveCount(4);
    for (let i = 1; i <= 3; i++) { await page.getByRole("button", { name: `Approve saved shot ${i}`, exact: true }).click(); await expect(page.getByRole("button", { name: `Approve saved shot ${i}`, exact: true })).toBeEnabled(); }
    await page.getByRole("button", { name: "Approve complete storyboard" }).click();
    await expect(page.getByRole("heading", { name: "Storyboard version 1 · approved" })).toBeVisible();
    await format.focus(); await format.press("l"); await format.press("Tab"); await expect(format).toHaveValue("landscape");
    await expect(page.getByRole("button", { name: "Render approved storyboard" })).toBeDisabled();
    await expect(page.locator("#video-format-help")).toContainText("1280 × 720");
    await page.getByRole("button", { name: "Save storyboard version" }).click();
    await expect(page.getByRole("heading", { name: "Storyboard version 2 · draft" })).toBeVisible();
    const board = await db.videoStoryboard.findFirstOrThrow({ where: { organizationId, version: 2 } }); expect(board.shotApprovals).toEqual([]);
    await page.getByRole("button", { name: "Approve complete storyboard" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Review every current shot" })).toBeVisible();
    const document = storyboardDocument.parse(board.document);
    for (const shot of document.shots) expect((await page.request.post(endpoint, { headers, data: { action: "review-shot", storyboardId: board.id, shotId: shot.id, approved: true } })).ok()).toBe(true);
    expect((await page.request.post(endpoint, { headers, data: { action: "approve-storyboard", storyboardId: board.id } })).ok()).toBe(true);
    process.env.FFMPEG_PATH = process.env.TEST_FFMPEG_PATH!; process.env.FFPROBE_PATH = process.env.TEST_FFPROBE_PATH!;
    const output = await renderMotion(document, new Map());
    const render = await db.motionRender.create({ data: { businessId: id, organizationId, storyboardId: board.id, rendererVersion: MOTION_RENDERER_VERSION, documentHash: motionHash(document), objectKey: `format-fixture/${crypto.randomUUID()}`, status: "READY", bytes: output.bytes.length, sha256: createHash("sha256").update(output.bytes).digest("hex"), durationMs: output.durationMs, createdBy: actor.id, purgeAfter: new Date(Date.now() + 600000) } });
    // Actual encoder bytes through a browser-only private-media fixture. API review/export remain real.
    await page.route(`**${endpoint}/${render.id}?format=mp4&download=false`, route => route.fulfill({ contentType: "video/mp4", body: output.bytes }));
    await page.getByRole("button", { name: "Refresh video status" }).click();
    await page.getByRole("button", { name: "Preview saved video" }).click();
    const video = page.locator("video"); await expect.poll(() => video.evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight])).toEqual([1280, 720]);
    await video.evaluate((v: HTMLVideoElement) => v.play()); await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0); await video.evaluate((v: HTMLVideoElement) => v.pause());
    await page.getByRole("checkbox", { name: /I watched the complete/ }).check(); await page.getByRole("button", { name: "Approve finished video" }).click();
    await expect(page.getByRole("button", { name: "Download JSON" })).toBeEnabled();
    const downloadWait = page.waitForEvent("download"); await page.getByRole("button", { name: "Download JSON" }).click();
    const download = await downloadWait; expect(download.suggestedFilename()).toBe("motion-landscape.json");
    expect(JSON.parse(await readFile((await download.path())!, "utf8")).format).toBe("landscape");
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.getByRole("heading", { name: "Render and final review" }).scrollIntoViewIfNeeded(); await page.screenshot({ path: "../outputs/marketingbus-landscape-video.png" });
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await format.selectOption("square"); await expect(page.getByRole("button", { name: "Download JSON" })).toBeDisabled(); await expect(video).toHaveCount(0);
    await page.getByRole("button", { name: "Save storyboard version" }).click(); await expect(page.getByRole("heading", { name: "Storyboard version 3 · draft" })).toBeVisible();
    expect((await page.request.get(`${endpoint}/${render.id}?format=json&download=true`)).status()).toBe(409);
    await format.selectOption("feed"); await page.getByRole("button", { name: "Save storyboard version" }).click(); await expect(page.getByRole("heading", { name: "Storyboard version 4 · draft" })).toBeVisible();
    await db.membership.update({ where: { organizationId_userId: { organizationId, userId: actor.id } }, data: { role: "VIEWER" } });
    await page.getByRole("button", { name: "Refresh video status" }).click(); await expect(format).toBeDisabled();
    const current = await db.videoStoryboard.findFirstOrThrow({ where: { organizationId, version: 4 } });
    expect((await page.request.post(endpoint, { headers, data: { action: "save", storyboardId: current.id, document: { ...storyboardDocument.parse(current.document), format: "portrait" } } })).status()).toBe(404);
    expect(await db.reservation.count({ where: { organizationId } })).toBe(0);
  } finally {
    if (previous.ffmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previous.ffmpeg;
    if (previous.ffprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previous.ffprobe;
    if (organizationId) { await db.motionRender.deleteMany({ where: { organizationId } }); await db.videoStoryboard.deleteMany({ where: { organizationId } }); await db.organization.delete({ where: { id: organizationId } }); }
    await db.user.deleteMany({ where: { email } });
  }
});
