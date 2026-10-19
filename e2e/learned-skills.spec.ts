import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
const local = process.env.TEST_DATABASE_URL;
test.skip(!local, "Explicit local fixture database required");
if (local && (local !== process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(local).hostname))) throw Error("Local learning fixtures only");
test("feedback skills can be reviewed, activated and retired without a model call", async ({ page }) => {
 const db = new PrismaClient(), email = `skills-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
 let organizationId: string | undefined;
 try {
  expect((await page.request.post("/api/auth/register", { headers, data: { name: "Skill browser fixture", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
  const created = await page.request.post("/api/businesses", { headers, data: { name: "Design Studio", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", channels: ["LinkedIn"] } });
  expect(created.ok()).toBe(true); const { id } = await created.json();
  const business = await db.business.findUniqueOrThrow({ where: { id } }); organizationId = business.organizationId;
  expect((await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } })).ok()).toBe(true);
  const plan = await db.productionPlan.create({ data: { businessId: id, organizationId, brandVersion: 1, title: "Synthetic corrections", creditCeiling: 100 } });
  const content = { headline: "Considered spaces", caption: "Architecture for your home.", cta: "Meet us", visualDirection: "Editorial layout with approved brand colors.", rationale: "Show the business offering clearly.", evidenceUsed: [] };
  for (let i = 0; i < 2; i++) await db.productionItem.create({ data: { organizationId, planId: plan.id, title: "Corrected creative", format: "static", channel: "LinkedIn", brief: {}, revisions: { create: [
   { version: 1, content: { ...content, caption: `${content.caption} #Design` }, status: "SUPERSEDED", feedback: "No hashtags." },
   { version: 2, content, status: "APPROVED", approvedAt: new Date() },
  ] } } });
  await page.goto("/studio"); await page.getByRole("button", { name: "Memory", exact: true }).click();
  const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Skills learned from your corrections", exact: true }) });
  await panel.getByRole("button", { name: "Find lessons in approved corrections" }).click();
  await expect(panel.getByRole("heading", { name: "LinkedIn · Proposed", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Activate this rule" }).click();
  await expect(panel.getByRole("heading", { name: "LinkedIn · Active", exact: true })).toBeVisible();
  expect(await db.memory.count({ where: { businessId: id, kind: "APPROVED_SKILL" } })).toBe(1);
  // Persisted replacement at the memory boundary: browser activation must not
  // demand that the customer delete an unrelated preference to make room.
  const previous = await db.learningProposal.findFirstOrThrow({ where: { businessId: id, status: "SKILL_ACTIVE" } });
  await db.learningProposal.create({ data: { businessId: id, organizationId, brandVersion: 1,
   hypothesis: previous.hypothesis, evidence: previous.evidence!, status: "SKILL_PROPOSED" } });
  await db.memory.createMany({ data: Array.from({ length: 99 }, (_, i) => ({ businessId: id, organizationId: business.organizationId,
   kind: "EXPLICIT_PREFERENCE", text: `Preserve customer preference ${i}` })) });
  await page.reload(); await page.getByRole("button", { name: "Memory", exact: true }).click();
  await panel.getByRole("button", { name: "Activate this rule" }).click();
  await expect(panel.getByRole("heading", { name: "LinkedIn · Active", exact: true })).toHaveCount(1);
  await expect(panel.getByRole("heading", { name: "LinkedIn · Retired", exact: true })).toHaveCount(1);
  expect(await db.memory.count({ where: { businessId: id } })).toBe(100);
  expect(await db.memory.findUnique({ where: { id: previous.memoryId! } })).toBeNull();
  expect(await db.memory.count({ where: { businessId: id, kind: "EXPLICIT_PREFERENCE" } })).toBe(99);
  // Storage capacity is not a larger generation context allowance.
  expect((await page.request.get(`/api/businesses/${id}/knowledge-graph?task=copy&channel=LinkedIn`)).status()).toBe(409);
  await db.memory.deleteMany({ where: { businessId: id, kind: "EXPLICIT_PREFERENCE" } }); // This test's synthetic filler only.
  const graphResponse = await page.request.get(`/api/businesses/${id}/knowledge-graph?task=copy&channel=LinkedIn`);
  expect(graphResponse.ok()).toBe(true); expect(graphResponse.headers()["cache-control"]).toContain("no-store");
  const graph = await graphResponse.json(); expect(graph.businessId).toBe(id);
  expect(graph.edges.some((e: { relation: string }) => e.relation === "SUPPORTED_BY")).toBe(true);
  expect((await page.request.get(`/api/businesses/${id}/knowledge-graph?channel=unconfigured`)).status()).toBe(400);
  const anonymous = await page.context().browser()!.newContext();
  try { expect((await anonymous.request.get(`http://127.0.0.1:3000/api/businesses/${id}/knowledge-graph`)).status()).toBe(401); } finally { await anonymous.close(); }
  expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: "../outputs/marketingbus-learned-skills.png" });
  await panel.getByRole("button", { name: "Retire this rule" }).click();
  await expect(panel.getByRole("heading", { name: "LinkedIn · Retired", exact: true })).toHaveCount(2);
  expect(await db.memory.count({ where: { businessId: id, kind: "APPROVED_SKILL" } })).toBe(0);
  const retiredGraph = await (await page.request.get(`/api/businesses/${id}/knowledge-graph?task=copy&channel=LinkedIn`)).json();
  expect(retiredGraph.fingerprint).not.toBe(graph.fingerprint);
  expect(retiredGraph.nodes.some((n: { kind: string }) => n.kind === "skill")).toBe(false);
  expect(await db.reservation.count({ where: { organizationId } })).toBe(0);
  await db.membership.updateMany({ where: { organizationId }, data: { role: "VIEWER" } });
  expect((await page.request.post(`/api/businesses/${id}/learning`, { headers, data: { action: "reflect-skills" } })).status()).toBe(404);
 } finally {
  if (organizationId) await db.organization.delete({ where: { id: organizationId } });
  await db.user.deleteMany({ where: { email } }); await db.$disconnect();
 }
});
