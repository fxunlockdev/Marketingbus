import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { AUDIO_PROCESSOR_VERSION } from "../src/lib/video/audio-normalizer";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Requires localhost fixture DB.");
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Local fixtures only");
const db = new PrismaClient(); test.afterAll(async () => db.$disconnect());
test("instrumental review, editable music, invalidation and accessible mobile controls", async ({ page }) => {
  test.setTimeout(60000); const email = `music-ui-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" }; let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Music fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const response = await page.request.post("/api/businesses", { headers, data: { name: "Music studio", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["YouTube"] } });
    const { id } = await response.json(), business = await db.business.findUniqueOrThrow({ where: { id } }); organizationId = business.organizationId; const actor = await db.user.findUniqueOrThrow({ where: { email } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } }); await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "plan", version: 1 } });
    const item = await db.productionItem.findFirstOrThrow({ where: { plan: { businessId: id } } });
    const bytes = Buffer.alloc(44 + 20 * 48000 * 4); bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
    const track = await db.videoClip.create({ data: { businessId: id, organizationId, brandVersion: 1, label: "Local instrumental", mediaKind: "AUDIO", instrumentalConfirmedAt: new Date(), createdBy: actor.id, rightsConfirmedAt: new Date(), status: "READY", sourceKey: `no-network/${crypto.randomUUID()}`, sourceHash: "a".repeat(64), sourceBytes: bytes.length, objectKey: `no-network/${crypto.randomUUID()}`, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, durationMs: 20000, processorVersion: AUDIO_PROCESSOR_VERSION, purgeAfter: new Date(Date.now() + 86400000) } });
    // Only media bytes bypass external object storage. Authorization/review/versioning use real APIs.
    await page.route(`**/api/businesses/${id}/audio/${track.id}`, route => route.request().method() === "GET" ? route.fulfill({ contentType: "audio/wav", body: bytes }) : route.continue());
    await page.goto("/studio"); await page.getByRole("button", { name: "Asset studio", exact: true }).click(); await page.getByRole("button", { name: /Video & motion/ }).click();
    await expect(page.getByRole("button", { name: "Approve music Local instrumental", exact: true })).toBeDisabled(); await page.getByRole("button", { name: "Listen to Local instrumental", exact: true }).click();
    const audio = page.getByLabel("Review instrumental music: Local instrumental"); await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.duration)).toBe(20); expect(await audio.evaluate((a: HTMLAudioElement) => a.paused && !a.autoplay)).toBe(true);
    await page.getByRole("checkbox", { name: "I listened to the entire track and confirmed rights, no speech or vocals, and brand fit." }).check(); await page.getByRole("button", { name: "Approve music Local instrumental", exact: true }).click();
    await expect.poll(async () => (await db.videoClip.findUniqueOrThrow({ where: { id: track.id } })).status).toBe("APPROVED");
    await page.getByLabel("Planned creative").selectOption(item.id); await page.getByRole("button", { name: "Create or open storyboard" }).click(); await page.getByLabel("Instrumental soundtrack", { exact: true }).selectOption(track.id);
    await page.getByLabel("Music start (seconds)", { exact: true }).fill("10"); await expect(page.getByLabel("Music start (seconds)", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "Save storyboard version" }).click(); await expect(page.getByRole("alert").filter({ hasText: "music is unavailable" })).toBeVisible();
    await page.getByLabel("Music start (seconds)", { exact: true }).fill("1"); await page.getByLabel("Music volume (%)", { exact: true }).fill("30"); await page.getByLabel("Music fade in (seconds)", { exact: true }).fill("0.5");
    await page.getByRole("button", { name: "Save storyboard version" }).click(); await expect(page.getByRole("heading", { name: "Storyboard version 2 · draft" })).toBeVisible();
    for (let i = 1; i <= 3; i++) { await page.getByRole("button", { name: `Approve saved shot ${i}`, exact: true }).click(); await expect(page.getByRole("button", { name: `Approve saved shot ${i}`, exact: true })).toBeEnabled(); }
    await page.getByRole("button", { name: "Approve complete storyboard" }).click(); await expect(page.getByRole("heading", { name: "Storyboard version 2 · approved" })).toBeVisible();
    await page.getByLabel("Music volume (%)", { exact: true }).focus(); await page.keyboard.press("ArrowUp"); await expect(page.getByLabel("Music volume (%)", { exact: true })).toHaveValue("35");
    await page.getByRole("button", { name: "Save storyboard version" }).click(); await expect(page.getByRole("heading", { name: "Storyboard version 3 · draft" })).toBeVisible(); expect((await db.videoStoryboard.findFirstOrThrow({ where: { organizationId, version: 3 } })).shotApprovals).toEqual([]);
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.getByRole("region", { name: "Instrumental music library" }).screenshot({ path: "../outputs/marketingbus-instrumental-library.png" });
    await page.getByRole("button", { name: "Remove music Local instrumental", exact: true }).click(); await page.getByRole("button", { name: "Confirm music removal Local instrumental", exact: true }).click();
    await expect(page.getByLabel("Instrumental soundtrack", { exact: true }).getByRole("option", { name: "Unavailable music · replace or remove" })).toHaveCount(1);
    await page.getByLabel("Instrumental soundtrack", { exact: true }).selectOption(""); await page.getByRole("button", { name: "Save storyboard version" }).click(); await expect(page.getByRole("heading", { name: "Storyboard version 4 · draft" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(await db.reservation.count({ where: { organizationId } })).toBe(0);
    await db.membership.update({ where: { organizationId_userId: { organizationId, userId: actor.id } }, data: { role: "VIEWER" } }); expect((await page.request.post(`/api/businesses/${id}/audio/${track.id}`, { headers, data: { action: "approve", watched: true } })).status()).toBe(404);
    await page.context().clearCookies(); const anonymous = await page.request.get(`/api/businesses/${id}/audio`); expect(anonymous.status()).toBe(401); expect(anonymous.headers()["cache-control"]).toContain("no-store");
  } finally { if (organizationId) { await db.videoClip.deleteMany({ where: { organizationId } }); await db.videoStoryboard.deleteMany({ where: { organizationId } }); await db.organization.delete({ where: { id: organizationId } }); } await db.user.deleteMany({ where: { email } }); }
});
