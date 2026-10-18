import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { db } from "../src/lib/db";
import { manageComposition } from "../src/lib/composition/service";
import { saveCompositionExport } from "../src/lib/composition/exports";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Requires explicit localhost fixture database.");
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Refusing non-local fixture writes");
test.afterAll(async () => db.$disconnect());
for (const provider of ["LinkedIn", "Facebook"]) test(`${provider} approved image selection preserves exact-version scope, keyboard submission and fail-closed integration`, async ({ page, browser }) => {
  const email = `social-image-ui-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Image publishing fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const response = await page.request.post("/api/businesses", { headers, data: { name: "Image studio", offering: "Design consultations", audience: "Homeowners", goal: "Book consultations", channels: [provider] } });
    const { id } = await response.json(); organizationId = (await db.business.findUniqueOrThrow({ where: { id } })).organizationId;
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } });
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "plan", version: 1 } });
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const scope = { businessId: id, organizationId, actorId: user.id };
    const item = await db.productionItem.findFirstOrThrow({ where: { plan: { businessId: id }, format: "static" } });
    await db.creativeRevision.create({ data: { itemId: item.id, organizationId, version: 1, status: "APPROVED", content: { headline: "Considered spaces", caption: "Design consultations for homeowners.", cta: "Meet us", visualDirection: "Brand typography", rationale: "Local fixture", evidenceUsed: [] } } });
    const composition = await manageComposition(scope, { action: "create", itemId: item.id, revisionVersion: 1 });
    await manageComposition(scope, { action: "approve", itemId: item.id, version: 1, rendererVersion: "static-outlines-v2" });
    const objects = new Map<string, Uint8Array>();
    const saved = await saveCompositionExport(scope, composition.composition.id, "square", { put: async (k, b) => { objects.set(k, b); }, get: async k => objects.get(k)!, remove: async k => { objects.delete(k); } });
    const connection = await db.socialConnection.create({ data: { organizationId, businessId: id, provider, externalAccountId: provider === "Facebook" ? "789" : "urn:li:organization:123", label: "Design company", encryptedToken: "never-return-this-fixture", permissions: [], expiresAt: new Date(Date.now() + 3600000) } });
    const endpoint = `/api/businesses/${id}/social`, actual = await page.request.get(endpoint), actualBody = await actual.json();
    expect(actualBody.imageProviders).toEqual([]);
    expect(actualBody.mediaChoices).toEqual([expect.objectContaining({ id: saved.id, itemId: item.id, revisionVersion: 1, placement: "square" })]);
    for (const secret of ["objectKey", "encryptedToken", "mediaTransferVersion", "never-return-this-fixture"]) expect(JSON.stringify(actualBody)).not.toContain(secret);
    await page.goto("/studio"); await page.getByRole("button", { name: "Publishing & analytics", exact: true }).click();
    await page.getByLabel("Approved creative", { exact: true }).selectOption(item.id);
    await expect(page.getByLabel("Approved image export", { exact: true })).toBeDisabled();
    // UI capability only. The actual POST still hits the disabled real adapter boundary.
    await page.route(`**${endpoint}`, async route => {
      if (route.request().method() !== "GET") return route.continue();
      const result = await route.fetch(), data = await result.json();
      await route.fulfill({ response: result, json: { ...data, enabledProviders: [provider], imageProviders: [provider] } });
    });
    await page.reload(); await page.getByRole("button", { name: "Publishing & analytics", exact: true }).click();
    await page.getByLabel("Approved creative", { exact: true }).selectOption(item.id);
    await page.getByLabel("Approved image export", { exact: true }).selectOption(saved.id);
    if (provider === "Facebook") await expect(page.locator("#social-image-help")).toContainText("4 MB or smaller");
    await expect(page.getByRole("link", { name: "Download selected approved image" })).toHaveAttribute("href", `/api/businesses/${id}/exports/${saved.id}`);
    await page.getByLabel("Destination account", { exact: true }).selectOption(connection.id);
    await page.getByLabel("Publish at (your local timezone)", { exact: true }).fill("2026-11-01T12:00");
    const failed = page.waitForResponse(r => r.url().endsWith(endpoint) && r.request().method() === "POST");
    const button = page.getByRole("button", { name: "Schedule social publication", exact: true }); await button.focus(); await page.keyboard.press("Enter");
    const submitted = await failed; expect(submitted.status()).toBe(503); expect(submitted.request().postDataJSON()).toMatchObject({ mediaExportId: saved.id, itemId: item.id, version: 1, connectionId: connection.id });
    const alert = page.getByRole("main").getByRole("alert"); await expect(alert).toContainText("not connected"); await expect(alert).toBeFocused();
    await expect(page.getByLabel("Approved image export", { exact: true })).toHaveValue(saved.id);
    expect(await db.socialPublication.count({ where: { businessId: id } })).toBe(0);
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel("Approved creative", { exact: true }).selectOption(""); await expect(page.getByLabel("Approved image export", { exact: true })).toHaveCount(0);
    await page.getByLabel("Approved creative", { exact: true }).selectOption(item.id); await expect(page.getByLabel("Approved image export", { exact: true })).toHaveValue("");
    await db.membership.updateMany({ where: { organizationId }, data: { role: "VIEWER" } });
    expect((await page.request.post(endpoint, { headers, data: { action: "schedule", itemId: item.id, version: 1, connectionId: connection.id, mediaExportId: saved.id, scheduledFor: new Date(Date.now() + 120000).toISOString(), timezone: "UTC" } })).status()).toBe(404);
    const anonymous = await browser.newContext();
    try { expect((await anonymous.request.get(`http://127.0.0.1:3000${endpoint}`)).status()).toBe(401); } finally { await anonymous.close(); }
  } finally {
    if (organizationId) { await db.socialPublication.deleteMany({ where: { organizationId } }); await db.compositionExport.deleteMany({ where: { organizationId } }); await db.organization.delete({ where: { id: organizationId } }); }
    await db.user.deleteMany({ where: { email } });
  }
});
