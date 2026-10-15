import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { renderMotion } from "../src/lib/video/render";
import { storyboardDocument } from "../src/lib/video/document";
import { MOTION_RENDERER_VERSION, motionHash } from "../src/lib/video/limits";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Requires explicit localhost fixture database.");
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Refusing non-local fixture writes");
const db = new PrismaClient();
test.afterAll(async () => db.$disconnect());
test("storyboards preserve unchanged shot reviews and enforce renderer readiness", async ({ page }) => {
  const email = `storyboard-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Storyboard fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const created = await page.request.post("/api/businesses", { headers, data: { name: "Northline · local test", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["YouTube"] } });
    expect(created.ok()).toBe(true); const { id } = await created.json(); organizationId = (await db.business.findUniqueOrThrow({ where: { id } })).organizationId;
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "plan", version: 1 } });
    const item = await db.productionItem.findFirstOrThrow({ where: { plan: { businessId: id } } });
    await page.goto("/studio"); await page.getByRole("button", { name: "Video studio", exact: true }).click();
    await page.getByLabel("Planned creative").selectOption(item.id); await page.getByRole("button", { name: "Create or open storyboard" }).click();
    await expect(page.getByRole("heading", { name: "Storyboard version 1 · draft" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Render approved storyboard" })).toBeDisabled();
    for (let i = 1; i <= 3; i++) { await page.getByRole("button", { name: `Approve saved shot ${i}`, exact: true }).click(); await expect(page.getByRole("button", { name: `Approve saved shot ${i}`, exact: true })).toBeEnabled(); }
    await page.getByRole("button", { name: "Approve complete storyboard" }).click(); await expect(page.getByRole("heading", { name: "Storyboard version 1 · approved" })).toBeVisible();
    await page.getByRole("button", { name: "Render approved storyboard" }).click(); await expect(page.getByRole("alert").filter({ hasText: "Local motion rendering is paused" })).toBeVisible();
    expect(await db.motionRender.count({ where: { organizationId } })).toBe(0);
    await page.getByRole("textbox", { name: "On-screen caption", exact: true }).nth(1).fill("Considered spaces for everyday life");
    await expect(page.getByRole("button", { name: "Approve complete storyboard" })).toBeDisabled();
    await page.getByRole("button", { name: "Save storyboard version" }).click(); await expect(page.getByRole("heading", { name: "Storyboard version 2 · draft" })).toBeVisible();
    const board = await db.videoStoryboard.findFirstOrThrow({ where: { organizationId, version: 2 } }); expect(board.shotApprovals).toHaveLength(2);
    await page.getByRole("button", { name: "Approve complete storyboard" }).click(); await expect(page.getByRole("alert").filter({ hasText: "Review every current shot" })).toBeVisible();
    await page.getByRole("button", { name: "Approve saved shot 2", exact: true }).click(); await expect(page.getByRole("button", { name: "Approve complete storyboard" })).toBeEnabled();
    await page.getByRole("button", { name: "Approve complete storyboard" }).click(); await expect(page.getByRole("heading", { name: "Storyboard version 2 · approved" })).toBeVisible();
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "../outputs/video-storyboard-studio.png" });
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    if (organizationId) { await db.motionRender.deleteMany({ where: { organizationId } }); await db.videoStoryboard.deleteMany({ where: { organizationId } }); await db.organization.delete({ where: { id: organizationId } }); }
    await db.user.deleteMany({ where: { email } });
  }
});
test("real motion playback, final approval, captions export and removal", async ({ page }) => {
  test.skip(!process.env.TEST_FFMPEG_PATH || !process.env.TEST_FFPROBE_PATH, "Requires explicit test encoder paths.");
  test.setTimeout(60000);
  const email = `motion-review-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  const previous = { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Motion review fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const created = await page.request.post("/api/businesses", { headers, data: { name: "Northline · local test", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["YouTube"] } });
    expect(created.ok()).toBe(true); const { id } = await created.json();
    organizationId = (await db.business.findUniqueOrThrow({ where: { id } })).organizationId;
    const actor = await db.user.findUniqueOrThrow({ where: { email } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "plan", version: 1 } });
    const item = await db.productionItem.findFirstOrThrow({ where: { plan: { businessId: id } } }), endpoint = `/api/businesses/${id}/video`;
    const response = await page.request.post(endpoint, { headers, data: { action: "create", itemId: item.id } }); expect(response.ok()).toBe(true);
    const { storyboardId } = await response.json(), board = await db.videoStoryboard.findUniqueOrThrow({ where: { id: storyboardId } }), document = storyboardDocument.parse(board.document);
    for (const shot of document.shots) expect((await page.request.post(endpoint, { headers, data: { action: "review-shot", storyboardId, shotId: shot.id, approved: true } })).ok()).toBe(true);
    expect((await page.request.post(endpoint, { headers, data: { action: "approve-storyboard", storyboardId } })).ok()).toBe(true);
    process.env.FFMPEG_PATH = process.env.TEST_FFMPEG_PATH!; process.env.FFPROBE_PATH = process.env.TEST_FFPROBE_PATH!;
    const output = await renderMotion(document, new Map());
    // Real encoder bytes, but test-only private-media transport. No production store/provider is replaced.
    const render = await db.motionRender.create({ data: { businessId: id, organizationId, storyboardId, rendererVersion: MOTION_RENDERER_VERSION, documentHash: motionHash(document), objectKey: `browser-fixture/${crypto.randomUUID()}`, status: "READY", bytes: output.bytes.length, sha256: createHash("sha256").update(output.bytes).digest("hex"), durationMs: output.durationMs, createdBy: actor.id, purgeAfter: new Date(Date.now() + 600000) } });
    await page.route(`**${endpoint}/${render.id}?format=mp4&download=false`, route => route.fulfill({ contentType: "video/mp4", body: output.bytes }));
    await page.goto("/studio"); await page.getByRole("button", { name: "Video studio", exact: true }).click();
    await page.getByLabel("Planned creative").selectOption(item.id);
    await expect(page.getByRole("button", { name: "Approve finished video" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Download MP4" })).toBeDisabled();
    await page.getByRole("button", { name: "Preview saved video" }).click();
    const video = page.locator("video"); await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(720);
    await video.evaluate((v: HTMLVideoElement) => v.play());
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0);
    await video.evaluate((v: HTMLVideoElement) => v.pause());
    await page.getByRole("checkbox", { name: /I watched the complete/ }).check();
    await page.getByRole("button", { name: "Approve finished video" }).click();
    await expect(page.getByRole("button", { name: "Download VTT" })).toBeEnabled();
    const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "Download VTT" }).click();
    const download = await downloadPromise; expect(await readFile((await download.path())!, "utf8")).toContain("Architecture consultations");
    expect((await db.motionRender.findUniqueOrThrow({ where: { id: render.id } })).status).toBe("APPROVED");
    await page.getByRole("button", { name: "Reject finished video" }).click(); await expect(page.getByRole("button", { name: "Download MP4" })).toBeDisabled();
    await page.getByRole("button", { name: "Remove saved video" }).click(); await page.getByRole("button", { name: "Confirm video removal" }).click();
    await expect(page.getByRole("button", { name: "Preview saved video" })).toHaveCount(0);
    expect((await db.motionRender.findUniqueOrThrow({ where: { id: render.id } })).status).toBe("ARCHIVED");
  } finally {
    if (previous.ffmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previous.ffmpeg;
    if (previous.ffprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previous.ffprobe;
    if (organizationId) { await db.motionRender.deleteMany({ where: { organizationId } }); await db.videoStoryboard.deleteMany({ where: { organizationId } }); await db.organization.delete({ where: { id: organizationId } }); }
    await db.user.deleteMany({ where: { email } });
  }
});
