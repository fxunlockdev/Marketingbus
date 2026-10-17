import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
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
    const base = { businessId: id, organizationId, actorId: actor.id, storyboardId, itemId: item.id, brandVersion: 1, shotId: "fixture", documentHash: "fixture", prompt: "PRIVATE PROMPT MUST STAY SERVER SIDE", configurationHash: "private-configuration", durationMs: 5000, credits: 10, supplierCeilingMicros: 100000, route: { privateOperatorKey: "never-display" }, expiresAt: new Date(Date.now() + 600000) };
    // Controlled local states, not a live supplier run. No fixture transport enters the app.
    const offered = await db.videoGeneration.create({ data: { ...base, shotLabel: "Unaccepted quote" } });
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
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await panel.screenshot({ path: "../outputs/marketingbus-generated-shot-jobs.png" });
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await db.membership.update({ where: { organizationId_userId: { organizationId, userId: actor.id } }, data: { role: "VIEWER" } });
    expect((await page.request.post(`/api/businesses/${id}/video-generations`, { headers, data: { action: "cancel", generationId: uncertain.id } })).status()).toBe(404);
    expect((await page.request.get("/api/businesses/another-business/video-generations")).status()).toBe(404);
    await page.context().clearCookies(); expect((await page.request.get(`/api/businesses/${id}/video-generations`)).status()).toBe(401);
  } finally {
    if (organizationId) { await db.videoGeneration.deleteMany({ where: { organizationId } }); await db.videoStoryboard.deleteMany({ where: { organizationId } }); await db.organization.delete({ where: { id: organizationId } }); }
    await db.user.deleteMany({ where: { email } });
  }
});
