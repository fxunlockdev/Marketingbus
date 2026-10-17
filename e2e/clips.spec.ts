import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { renderMotion } from "../src/lib/video/render";
import { storyboardDocument } from "../src/lib/video/document";
import { CLIP_PROCESSOR_VERSION } from "../src/lib/video/clip-normalizer";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local || !process.env.TEST_FFMPEG_PATH || !process.env.TEST_FFPROBE_PATH, "Requires localhost fixture DB and encoder.");
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Local fixtures only");
const db = new PrismaClient();
test.afterAll(async () => db.$disconnect());
test("reviewed footage plays, joins a storyboard, and removal invalidates dependent review", async ({ page }) => {
  test.setTimeout(60000);
  const email = `clip-ui-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  const previous = { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Clip fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const response = await page.request.post("/api/businesses", { headers, data: { name: "Clip studio", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["YouTube"] } });
    const { id } = await response.json(), business = await db.business.findUniqueOrThrow({ where: { id } }); organizationId = business.organizationId;
    const actor = await db.user.findUniqueOrThrow({ where: { email } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "plan", version: 1 } });
    const item = await db.productionItem.findFirstOrThrow({ where: { plan: { businessId: id } } });
    process.env.FFMPEG_PATH = process.env.TEST_FFMPEG_PATH; process.env.FFPROBE_PATH = process.env.TEST_FFPROBE_PATH;
    const media = await renderMotion(storyboardDocument.parse({ title: "Silent review fixture", background: "#e5d9c7", logo: null, shots: [{ id: "local", label: "Local", caption: "Local fixture", durationMs: 6000, motion: "hold", asset: null }] }), new Map());
    const clip = await db.videoClip.create({ data: { businessId: id, organizationId, brandVersion: 1, label: "Local studio footage", createdBy: actor.id, rightsConfirmedAt: new Date(), status: "READY", sourceKey: `no-network/${crypto.randomUUID()}`, sourceHash: "b".repeat(64), sourceBytes: 100, objectKey: `no-network/${crypto.randomUUID()}`, sha256: createHash("sha256").update(media.bytes).digest("hex"), bytes: media.bytes.length, durationMs: 6000, processorVersion: CLIP_PROCESSOR_VERSION, purgeAfter: new Date(Date.now() + 86400000) } });
    // Only bytes are intercepted. Review, selection, invalidation and access checks use real scoped APIs.
    await page.route(`**/api/businesses/${id}/clips/${clip.id}`, route => route.request().method() === "GET" ? route.fulfill({ contentType: "video/mp4", body: media.bytes }) : route.continue());
    await page.goto("/studio"); await page.getByRole("button", { name: "Video studio", exact: true }).click();
    await expect(page.getByRole("button", { name: "Approve Local studio footage", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Preview Local studio footage", exact: true }).click();
    const video = page.getByLabel("Silent clip Local studio footage"); await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(720);
    await page.getByRole("checkbox", { name: "I watched this entire clip and reviewed rights, accuracy and brand fidelity." }).check();
    await page.getByRole("button", { name: "Approve Local studio footage", exact: true }).click();
    await expect.poll(async () => (await db.videoClip.findUniqueOrThrow({ where: { id: clip.id } })).status).toBe("APPROVED");
    await page.getByLabel("Planned creative").selectOption(item.id); await page.getByRole("button", { name: "Create or open storyboard" }).click();
    await page.getByRole("combobox", { name: "Scene footage", exact: true }).first().selectOption(clip.id); await page.getByRole("button", { name: "Save storyboard version" }).click();
    await expect(page.getByRole("heading", { name: "Storyboard version 2 · draft" })).toBeVisible();
    for (let i = 1; i <= 3; i++) { await page.getByRole("button", { name: `Approve saved shot ${i}`, exact: true }).click(); await expect(page.getByRole("button", { name: `Approve saved shot ${i}`, exact: true })).toBeEnabled(); }
    await page.getByRole("button", { name: "Approve complete storyboard" }).click(); await expect(page.getByRole("heading", { name: "Storyboard version 2 · approved" })).toBeVisible();
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Remove Local studio footage", exact: true }).click(); await page.getByRole("button", { name: "Confirm removal of Local studio footage", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Scene footage", exact: true }).first().getByRole("option", { name: "Unavailable clip · choose a replacement" })).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Storyboard version 2 · draft" })).toBeVisible();
    await page.getByRole("button", { name: "Approve saved shot 1", exact: true }).click(); await expect(page.getByRole("alert").filter({ hasText: "scene clip is unavailable" })).toBeVisible();
    await page.getByRole("combobox", { name: "Scene footage", exact: true }).first().selectOption(""); await page.getByRole("button", { name: "Save storyboard version" }).click(); await expect(page.getByRole("heading", { name: "Storyboard version 3 · draft" })).toBeVisible();
    await page.getByRole("region", { name: "Private footage library" }).screenshot({ path: "../outputs/marketingbus-reviewed-clips.png" });
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await db.reservation.count({ where: { organizationId } })).toBe(0);
    await db.membership.update({ where: { organizationId_userId: { organizationId, userId: actor.id } }, data: { role: "VIEWER" } });
    expect((await page.request.post(`/api/businesses/${id}/clips/${clip.id}`, { headers, data: { action: "approve", watched: true } })).status()).toBe(404);
    await page.context().clearCookies(); expect((await page.request.get(`/api/businesses/${id}/clips`)).status()).toBe(401);
  } finally {
    if (previous.ffmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previous.ffmpeg;
    if (previous.ffprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previous.ffprobe;
    if (organizationId) { await db.videoClip.deleteMany({ where: { organizationId } }); await db.videoStoryboard.deleteMany({ where: { organizationId } }); await db.organization.delete({ where: { id: organizationId } }); }
    await db.user.deleteMany({ where: { email } });
  }
});
