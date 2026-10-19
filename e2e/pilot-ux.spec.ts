import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { PrismaClient } from "@prisma/client";
import { episodeRefs, procedureEpisodes, procedureText } from "../src/lib/harness/procedure-evidence";
test("new account sees publishing choices and compact accessible onboarding", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const email = `pilot-ux-${crypto.randomUUID()}@example.test`;
  expect((await page.request.post("/api/auth/register", { headers: { Origin: "http://127.0.0.1:3000" }, data: { name: "Pilot UX", email, password: "Test-only-password-2026!" } })).ok()).toBe(true);
  await page.goto("/studio"); await page.getByRole("button", { name: "Connections", exact: true }).click();
  const catalogue = page.getByRole("region", { name: "Publishing destination catalogue" });
  for (const name of ["Instagram", "Facebook", "LinkedIn"]) await expect(catalogue.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(catalogue.getByText("Business setup required")).toHaveCount(3);
  await catalogue.getByRole("button", { name: "Set up your business" }).click();
  const setup = page.getByRole("region", { name: "Guided business setup" });
  const button = setup.getByRole("button", { name: "Start business setup" });
  await expect(button).toBeVisible(); const box = await button.boundingBox(); expect(box!.y + box!.height).toBeLessThan(900);
  expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "../outputs/marketingbus-v53-onboarding.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await button.scrollIntoViewIfNeeded(); await expect(button).toBeVisible();
});
test("review filters combine channel and format, and reviewed procedures recall into matching work", async ({ page }) => {
  const database = process.env.TEST_DATABASE_URL;
  test.skip(!database, "Local fixture database required");
  if (database !== process.env.DATABASE_URL || !["127.0.0.1", "localhost"].includes(new URL(database!).hostname)) throw Error("Local fixtures only");
  const db = new PrismaClient(), email = `procedure-ux-${crypto.randomUUID()}@example.test`, headers = { Origin: "http://127.0.0.1:3000" };
  let org: string | undefined;
  try {
    expect((await page.request.post("/api/auth/register", { headers, data: { email, password: "Test-only-password-2026!", name: "Creative review" } })).ok()).toBe(true);
    const response = await page.request.post("/api/businesses", { headers, data: { name: "Design practice", offering: "Design consultations", audience: "Homeowners", goal: "Book consultations", channels: ["LinkedIn", "Instagram"] } });
    expect(response.ok()).toBe(true); const { id } = await response.json(), business = await db.business.findUniqueOrThrow({ where: { id } }), user = await db.user.findUniqueOrThrow({ where: { email } }); org = business.organizationId;
    await page.request.post(`/api/businesses/${id}`, { headers, data: { action: "confirm", version: 1 } });
    const plan = await db.productionPlan.create({ data: { businessId: id, organizationId: org, brandVersion: 1, title: "Synthetic review plan", creditCeiling: 100 } });
    const copy = { headline: "Design with care", caption: "Consider the details of your home.", cta: "Meet us", visualDirection: "Quiet natural lighting and generous space.", rationale: "Specific offering", evidenceUsed: [] };
    for (const format of ["static", "motion"]) await db.productionItem.create({ data: { organizationId: org, planId: plan.id, title: `Review fixture ${format}`, format, channel: "LinkedIn", brief: {}, revisions: { create: [
      { version: 1, status: "SUPERSEDED", content: copy, feedback: "Please lead with a thoughtful detail rather than self-praise." },
      { version: 2, status: "APPROVED", content: copy, approvedAt: new Date(), approvedBy: user.id },
    ] } } });
    const scope = { businessId: id, organizationId: org, actorId: user.id }, episodes = await procedureEpisodes(db, scope, 1);
    const candidate = { channel: "LinkedIn" as const, task: "copy" as const, scenario: "When presenting design work", instruction: "Lead with a concrete detail rather than self-praise.", limitation: "Do not invent facts.", reviewCheck: "Check specificity of the opening.", examples: episodes.map(e => ({ id: e.id, feedbackQuote: "Please lead with a thoughtful detail", approvedQuote: "Consider the details of your home." })) };
    await db.learningProposal.create({ data: { businessId: id, organizationId: org, brandVersion: 1, hypothesis: procedureText(candidate), status: "PROCEDURE_PROPOSED", evidence: { kind: "CREATIVE_PROCEDURE_V1", analysisId: "browser-fixture", candidate, sources: episodeRefs(episodes) } } });
    await page.goto("/studio"); await page.getByRole("button", { name: "Review inbox", exact: true }).click();
    await page.getByRole("group", { name: "Filter review by platform" }).getByRole("button", { name: "LinkedIn", exact: true }).click();
    await page.getByRole("button", { name: "Video & motion", exact: true }).click();
    await expect(page.getByRole("article", { name: "LinkedIn: Review fixture motion", exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: "LinkedIn: Review fixture static", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Images & posts", exact: true }).click();
    await expect(page.getByRole("article", { name: "LinkedIn: Review fixture static", exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: "LinkedIn: Review fixture motion", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Memory", exact: true }).click();
    const panel = page.getByRole("region", { name: "Creative lessons beyond simple rules" });
    await expect(panel.getByRole("button", { name: "Activate reviewed procedure" })).toBeDisabled();
    await panel.getByLabel("I checked the meaning and evidence", { exact: false }).check();
    await panel.getByRole("button", { name: "Activate reviewed procedure" }).click();
    await expect(panel.getByRole("heading", { name: "LinkedIn · copy · active" })).toBeVisible();
    const graph = await (await page.request.get(`/api/businesses/${id}/knowledge-graph?task=copy&channel=LinkedIn`)).json();
    expect(graph.nodes.some((n: { text: string }) => n.text.includes("concrete detail"))).toBe(true);
    expect((await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await panel.getByRole("button", { name: "Retire procedure", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "LinkedIn · copy · retired" })).toBeVisible();
  } finally { if (org) await db.organization.delete({ where: { id: org } }); await db.user.deleteMany({ where: { email } }); await db.$disconnect(); }
});
