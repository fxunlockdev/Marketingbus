import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { assetStore } from "../src/lib/assets/storage";
const local = process.env.TEST_DATABASE_URL;
test.skip(process.env.RUN_ASSET_STORAGE_E2E !== "true", "Requires explicitly configured private storage and a local database.");
if (process.env.RUN_ASSET_STORAGE_E2E === "true" && (!local || process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Refusing non-local browser fixture writes");
const db = new PrismaClient();
test.afterAll(async () => { await db.$disconnect(); });
test("private brand upload, browser preview and cross-tenant access denial", async ({ page, playwright }) => {
  test.setTimeout(90_000);
  const email = `asset-fixture-${crypto.randomUUID()}@example.test`;
  const otherEmail = `asset-outsider-${crypto.randomUUID()}@example.test`;
  const headers = { Origin: "http://127.0.0.1:3000" };
  const outsider = await playwright.request.newContext({ baseURL: "http://127.0.0.1:3000" });
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Asset Fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const created = await page.request.post("/api/businesses", { headers, data: { name: "Private Asset Fixture", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["Instagram"] } });
    expect(created.ok()).toBe(true); const { id } = await created.json();
    organizationId = (await db.business.findUniqueOrThrow({ where: { id } })).organizationId;
    await page.goto("/studio"); await page.getByRole("button", { name: "Brand", exact: true }).click();
    await page.getByText("Photos, logos and documents", { exact: true }).click();
    await page.getByLabel("Image label", { exact: true }).fill("Private fixture logo");
    const png = await sharp({ create: { width: 80, height: 60, channels: 4, background: "#c67139" } }).png().toBuffer();
    await page.getByLabel("Image file", { exact: true }).setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: png });
    await page.getByRole("combobox", { name: "Use this as", exact: true }).selectOption("logo");
    await page.getByLabel("I have permission to upload and use this image for this business.").check();
    await page.getByRole("button", { name: "Upload private image", exact: true }).click();
    await expect(page.getByRole("region", { name: "Your brand assets" }).getByRole("status")).toContainText("Image saved privately", { timeout: 45000 });
    const img = page.getByRole("img", { name: "Private fixture logo", exact: true });
    await expect(img).toBeVisible(); await expect.poll(() => img.evaluate(e => (e as HTMLImageElement).naturalWidth)).toBe(80);
    const asset = await db.brandAsset.findFirstOrThrow({ where: { businessId: id } });
    const read = await page.request.get(`/api/businesses/${id}/assets/${asset.id}`);
    expect(read.status()).toBe(200); expect(read.headers()["cache-control"]).toContain("no-store");
    expect(read.headers()["content-type"]).toBe("image/webp");
    expect((await outsider.post("/api/auth/register", { headers, data: { name: "Outsider Fixture", email: otherEmail, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    expect((await outsider.get(`/api/businesses/${id}/assets/${asset.id}`)).status()).toBe(404);
    expect((await outsider.get(`/api/businesses/${id}/assets`)).status()).toBe(404);
    await page.getByRole("button", { name: "Approve for generation · Private fixture logo", exact: true }).click();
    await expect(page.getByRole("button", { name: "Revoke generation permission · Private fixture logo", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect((await db.brandAsset.findUniqueOrThrow({ where: { id: asset.id } })).approvedForGeneration).toBe(true);
    await page.getByRole("button", { name: "Remove image · Private fixture logo", exact: true }).click();
    await page.getByRole("button", { name: "Confirm removal · Private fixture logo", exact: true }).click();
    await expect(img).toHaveCount(0);
    expect((await page.request.get(`/api/businesses/${id}/assets/${asset.id}`)).status()).toBe(404);
    await page.getByRole("button", { name: "Restore image · Private fixture logo", exact: true }).click();
    await expect(img).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve for generation · Private fixture logo", exact: true })).toHaveAttribute("aria-pressed", "false");
    await db.membership.updateMany({ where: { organizationId }, data: { role: "VIEWER" } });
    expect((await page.request.post(`/api/businesses/${id}/assets`, { headers, data: png })).status()).toBe(404);
    await page.getByRole("heading", { name: "Your brand assets", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "../outputs/marketingbus-private-assets.png" });
  } finally {
    if (organizationId) {
      const assets = await db.brandAsset.findMany({ where: { organizationId } });
      for (const asset of assets) await assetStore().remove(asset.objectKey);
      await db.brandAsset.deleteMany({ where: { organizationId } });
      await db.organization.delete({ where: { id: organizationId } });
    }
    const other = await db.user.findUnique({ where: { email: otherEmail }, include: { memberships: true } });
    if (other) await db.organization.deleteMany({ where: { id: { in: other.memberships.map(m => m.organizationId) } } });
    await db.user.deleteMany({ where: { email: { in: [email, otherEmail] } } });
    await outsider.dispose();
  }
});
