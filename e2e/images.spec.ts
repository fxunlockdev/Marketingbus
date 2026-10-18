import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import sharp from "sharp";
import { createHash } from "node:crypto";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Requires explicit localhost fixture database.");
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Refusing non-local fixture writes");
const db = new PrismaClient();
test.afterAll(async () => db.$disconnect());
test("image review, reject, approve and scoped revision controls", async ({ page }) => {
  const email = `artwork-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Artwork review fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const created = await page.request.post("/api/businesses", { headers, data: { name: "Atelier North · local test", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["Instagram"] } });
    expect(created.ok()).toBe(true); const { id } = await created.json();
    organizationId = (await db.business.findUniqueOrThrow({ where: { id } })).organizationId;
    const actor = await db.user.findUniqueOrThrow({ where: { email } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "plan", version: 1 } });
    const item = await db.productionItem.findFirstOrThrow({ where: { plan: { businessId: id }, format: "static" } });
    const revision = await db.creativeRevision.create({ data: { itemId: item.id, organizationId, version: 1, status: "APPROVED", content: { headline: "Space to feel at home", caption: "Considered architecture for your home.", cta: "Explore our approach", visualDirection: "Quiet architectural light", rationale: "Browser fixture, not model output", evidenceUsed: [] } } });
    // Only the preview transport is stubbed in this browser test. Real scoped review APIs execute.
    // Worker/storage lifecycle and immutable byte verification are tested in the database suite.
    const bytes = await sharp({ create: { width: 600, height: 600, channels: 4, background: "#d7bfa4" } }).webp().toBuffer();
    const job = await db.imageGeneration.create({ data: { businessId: id, organizationId, actorId: actor.id, itemId: item.id, revisionId: revision.id, brandVersion: 1, version: 1, prompt: "Synthetic browser fixture only", references: [], route: {}, configurationHash: "fixture", credits: 10, supplierCeilingMicros: 100000, expiresAt: new Date(Date.now() + 600000), acceptedAt: new Date(), status: "READY" } });
    await db.brandAsset.create({ data: { businessId: id, organizationId, generationId: job.id, objectKey: `browser-fixture/${job.id}`, label: "Synthetic review fixture", purpose: "generated", status: "READY", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, width: 600, height: 600, uploadedBy: actor.id, rightsConfirmedAt: new Date() } });
    await page.route(`**/api/businesses/${id}/images/${job.id}`, route => route.fulfill({ contentType: "image/webp", body: bytes }));
    await page.goto("/studio"); await page.getByRole("button", { name: "Asset studio", exact: true }).click();
    await page.getByLabel("Approved creative", { exact: true }).selectOption(item.id);
    await expect(page.getByRole("heading", { name: "Artwork version 1 · ready" })).toBeVisible();
    const approve = page.getByRole("button", { name: "Approve artwork for composition" }); await expect(approve).toBeDisabled();
    await page.getByRole("button", { name: "Preview artwork for review" }).click();
    await expect(page.getByAltText("Generated supporting artwork awaiting brand and factual review")).toBeVisible();
    await page.getByRole("checkbox", { name: /I reviewed the actual image/ }).check(); await expect(approve).toBeEnabled();
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await approve.click(); await expect(page.getByRole("heading", { name: "Artwork version 1 · approved" })).toBeVisible();
    expect((await db.imageGeneration.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("APPROVED");
    await page.getByRole("button", { name: "Reject artwork · no regeneration" }).click(); await expect(page.getByRole("heading", { name: "Artwork version 1 · rejected" })).toBeVisible();
    expect(await db.reservation.count({ where: { organizationId } })).toBe(0);
    await page.getByLabel("Specific revision request").fill("Use warmer light but preserve the framing.");
    await expect(page.getByRole("button", { name: "Quote this revision" })).toBeEnabled();
    await page.getByRole("button", { name: "Quote this revision" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Paid production is paused" })).toBeVisible();
    await page.screenshot({ path: "../outputs/image-production-review.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    if (organizationId) {
      await db.brandAsset.deleteMany({ where: { organizationId } }); await db.imageGeneration.deleteMany({ where: { organizationId } });
      await db.organization.delete({ where: { id: organizationId } });
    }
    await db.user.deleteMany({ where: { email } });
  }
});
