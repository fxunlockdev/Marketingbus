import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import { seedLearningEvidence, seedInstagramLearningEvidence } from "../tests/fixtures/learning";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Explicit local fixture database required");
if (local && (local !== process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(local).hostname))) throw Error("Refusing non-local learning fixtures");
for (const provider of ["LinkedIn", "Instagram"] as const) test(`${provider} matched evidence is reviewable, approval is reversible, and changed metrics block promotion`, async ({ page }) => {
  const db = new PrismaClient(), email = `learning-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let organizationId: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { name: "Learning browser fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
    const created = await page.request.post("/api/businesses", { headers, data: { name: "Learning Studio", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["Facebook"] } });
    expect(created.ok()).toBe(true); const { id } = await created.json();
    const business = await db.business.findUniqueOrThrow({ where: { id } }); organizationId = business.organizationId;
    expect((await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } })).ok()).toBe(true);
    expect((await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "plan", version: 1 } })).ok()).toBe(true);
    const plan = await db.productionPlan.findFirstOrThrow({ where: { businessId: id } });
    const connection = await db.socialConnection.create({ data: { id: crypto.randomUUID(), businessId: id, organizationId, provider: "Facebook", externalAccountId: "local-fixture", label: "Local fixture only", encryptedToken: "not-a-provider-token", permissions: [], status: "CONNECTED" } });
    const fixture = await (provider === "Instagram" ? seedInstagramLearningEvidence : seedLearningEvidence)(db, { businessId: id, organizationId, planId: plan.id, connectionId: connection.id });
    await page.goto("/studio"); await page.getByRole("button", { name: "Publishing & analytics", exact: true }).click();
    await page.getByRole("button", { name: "Evaluate available evidence", exact: true }).click();
    await expect(page.getByText("PROPOSED", { exact: true })).toBeVisible();
    await page.getByText("View supporting observations", { exact: true }).click();
    await expect(page.getByText(provider === "Instagram" ? /INSTAGRAM_NATIVE_VIEWS_72_96_HOURS_V1/ : /MATCHED_72_96_HOURS_V1/)).toBeVisible();
    await page.getByRole("button", { name: "Approve as an experiment", exact: true }).click();
    await expect(page.getByText("PROMOTED", { exact: true })).toBeVisible();
    expect(await db.memory.count({ where: { businessId: id, kind: "APPROVED_EXPERIMENT" } })).toBe(1);
    await page.getByRole("button", { name: "Revert experiment", exact: true }).click();
    await expect(page.getByText("REVERTED", { exact: true })).toBeVisible();
    expect(await db.memory.count({ where: { businessId: id, kind: "APPROVED_EXPERIMENT" } })).toBe(0);
    await page.getByRole("button", { name: "Evaluate available evidence", exact: true }).click();
    await expect(page.getByText("PROPOSED", { exact: true })).toBeVisible();
    await db.metricSnapshot.update({ where: { id: fixture[0].metric.id }, data: { engagements: 51 } });
    await page.getByRole("button", { name: "Approve as an experiment", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("evidence is missing, changed or expired");
    expect(await db.memory.count({ where: { businessId: id, kind: "APPROVED_EXPERIMENT" } })).toBe(0);
    expect(await db.reservation.count({ where: { organizationId } })).toBe(0);
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const experiments = page.locator("section").filter({ has: page.getByRole("heading", { name: "Evidence-based experiments", exact: true }) });
    await experiments.scrollIntoViewIfNeeded();
    await experiments.screenshot({ path: `../outputs/marketingbus-learning-evidence-${provider.toLowerCase()}.png` });
    await db.membership.updateMany({ where: { organizationId }, data: { role: "VIEWER" } });
    expect((await page.request.post(`/api/businesses/${id}/learning`, { headers, data: { action: "evaluate" } })).status()).toBe(404);
  } finally {
    if (organizationId) { await db.socialPublication.deleteMany({ where: { organizationId } }); await db.organization.delete({ where: { id: organizationId } }); }
    await db.user.deleteMany({ where: { email } }); await db.$disconnect();
  }
});
