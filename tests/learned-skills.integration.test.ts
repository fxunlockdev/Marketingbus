import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { manageLearnedSkills, readLearnedSkills } from "../src/lib/harness/learning";
import { productionMemories } from "../src/lib/social/learning-evidence";
import { actOnProduction, type Scope } from "../src/lib/production/service";
import { runOneJob } from "../src/lib/production/worker";
import { heartbeat } from "../src/lib/production/readiness";
import { manageLearning } from "../src/lib/social/analytics";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local learning fixtures only");
const copy = { headline: "Considered spaces", caption: "Architecture for your home.", cta: "Meet us", visualDirection: "Editorial layout with approved brand colors.", rationale: "Show the business offering clearly.", evidenceUsed: [] };
suite("feedback to versioned business copy skills", () => {
 const organizations: string[] = [], users: string[] = [], worker = `skills-${crypto.randomUUID()}`;
 beforeAll(async () => {
  vi.stubEnv("PAID_EXECUTION_ENABLED", "true"); vi.stubEnv("OPENAI_API_KEY", "fixture-not-live");
  vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "50000000"); vi.stubEnv("TOTAL_SUPPLIER_BUDGET_MICROS", "1000000000");
  vi.stubEnv("REASONING_RATE_CARD_JSON", JSON.stringify(["creative", "routine"].map(lane => ({ provider: "openai", model: `FIXTURE-${lane}`, lane, inputUsdPerMillion: 1, outputUsdPerMillion: 1, verifiedUntil: "2099-01-01T00:00:00Z" })))); await heartbeat(worker);
 });
 afterAll(async () => {
  const quotes = await db.generationQuote.findMany({ where: { organizationId: { in: organizations } }, select: { id: true } });
  await db.supplierAuthorization.deleteMany({ where: { key: { in: quotes.map(q => q.id) } } });
  await db.organization.deleteMany({ where: { id: { in: organizations } } }); await db.user.deleteMany({ where: { id: { in: users } } }); await db.workerHeartbeat.deleteMany({ where: { id: worker } }); vi.unstubAllEnvs(); await db.$disconnect();
 });
 async function setup(count = 2) {
  const org = await db.organization.create({ data: { name: "Synthetic learning", wallet: { create: { available: 500 } } } }); organizations.push(org.id);
  const user = await db.user.create({ data: { name: "Synthetic learner", email: `${crypto.randomUUID()}@example.test`, passwordHash: "not-a-login", memberships: { create: { organizationId: org.id, role: "OWNER" } } } }); users.push(user.id);
  const business = await db.business.create({ data: { organizationId: org.id, name: "Any design business", offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations", confirmedAt: new Date() } });
  const plan = await db.productionPlan.create({ data: { organizationId: org.id, businessId: business.id, brandVersion: 1, title: "Feedback fixtures", creditCeiling: 100 } });
  const scope: Scope = { organizationId: org.id, businessId: business.id, actorId: user.id };
  const revisions: string[] = [];
  for (let i = 0; i < count; i++) {
   const item = await db.productionItem.create({ data: { organizationId: org.id, planId: plan.id, title: "Corrected creative", format: "static", channel: "LinkedIn", brief: {}, revisions: { create: [
    { version: 1, content: { ...copy, caption: `${copy.caption} #Design` }, status: "SUPERSEDED", feedback: "No hashtags." },
    { version: 2, content: copy, status: "APPROVED", approvedAt: new Date(), approvedBy: user.id },
   ] } }, include: { revisions: true } }); revisions.push(item.revisions.find(r => r.version === 2)!.id);
  }
  const next = await db.productionItem.create({ data: { organizationId: org.id, planId: plan.id, title: "Next creative", format: "static", channel: "LinkedIn", brief: {} } });
  return { scope, revisions, itemId: next.id };
 }
 const memories = (scope: Scope) => db.$transaction(tx => productionMemories(tx, scope, 1));
 async function activate(scope: Scope) {
  await manageLearnedSkills(scope, { action: "reflect-skills" }); const skill = (await readLearnedSkills(scope)).skills[0];
  await manageLearnedSkills(scope, { action: "activate-skill", proposalId: skill.id }); return skill;
 }
 it("requires two separate corrected creatives, deduplicates reflection, and never activates automatically", async () => {
  const a = await setup(1); expect(await manageLearnedSkills(a.scope, { action: "reflect-skills" })).toMatchObject({ created: 0 });
  const b = await setup(); expect(await manageLearnedSkills(b.scope, { action: "reflect-skills" })).toMatchObject({ created: 1 });
  expect(await manageLearnedSkills(b.scope, { action: "reflect-skills" })).toMatchObject({ created: 0 }); expect(await memories(b.scope)).toEqual([]);
 });
 it("automatically proposes a rule on approval and prunes it when evidence expires", async () => {
  const a = await setup();
  const revision = await db.creativeRevision.update({ where: { id: a.revisions[0] }, data: { status: "READY", approvedAt: null } });
  await actOnProduction(a.scope, { action: "approve", itemId: revision.itemId, version: 2 });
  const skill = (await readLearnedSkills(a.scope)).skills[0]; expect(skill.status).toBe("SKILL_PROPOSED");
  await manageLearnedSkills(a.scope, { action: "activate-skill", proposalId: skill.id });
  await expect(manageLearning(a.scope, { action: "reject", proposalId: skill.id })).rejects.toThrow("not found");
  await db.creativeRevision.update({ where: { id: revision.id }, data: { approvedAt: new Date(Date.now() - 91 * 86400000) } });
  await manageLearnedSkills(a.scope, { action: "reflect-skills" });
  expect((await readLearnedSkills(a.scope)).skills[0].status).toBe("SKILL_EXPIRED"); expect(await memories(a.scope)).toEqual([]);
 });
 it("retirement invalidates an outstanding quote before any supplier call", async () => {
  const a = await setup(), skill = await activate(a.scope);
  const q = await actOnProduction(a.scope, { action: "quote", itemId: a.itemId, mode: "initial", direction: "Show thoughtful architecture for homeowners." });
  const quote = (q as { quote: { id: string } }).quote;
  await manageLearnedSkills(a.scope, { action: "retire-skill", proposalId: skill.id });
  expect((await db.generationQuote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe("SUPERSEDED");
  await expect(actOnProduction(a.scope, { action: "accept", quoteId: quote.id })).rejects.toThrow();
  expect(await db.job.count({ where: { quoteId: quote.id } })).toBe(0);
 });
 it.each(["openai", "anthropic"] as const)("serves scoped verified skills to %s generation and retires them", async provider => {
  vi.stubEnv("REASONING_PROVIDERS_JSON", JSON.stringify([provider])); vi.stubEnv("ANTHROPIC_API_KEY", "fixture-not-live");
  vi.stubEnv("REASONING_RATE_CARD_JSON", JSON.stringify(["creative", "routine"].map(lane => ({ provider, model: `FIXTURE-${lane}`, lane, inputUsdPerMillion: 1, outputUsdPerMillion: 1, verifiedUntil: "2099-01-01T00:00:00Z" })))); await heartbeat(worker);
  const a = await setup(), skill = await activate(a.scope);
  const q = await actOnProduction(a.scope, { action: "quote", itemId: a.itemId, mode: "initial", direction: "Show thoughtful architecture for homeowners." });
  const quote = (q as { quote: { id: string } }).quote;
  const stored = await db.generationQuote.findUniqueOrThrow({ where: { id: quote.id } }); expect(JSON.stringify(stored.request)).toContain("NO_HASHTAGS");
  await actOnProduction(a.scope, { action: "accept", quoteId: quote.id }); await db.job.updateMany({ where: { quoteId: quote.id }, data: { availableAt: new Date(0) } });
  await runOneJob(async (selectedProvider, request) => { expect(selectedProvider).toBe(provider); expect(request.input).toContain("Learned copy skill [LinkedIn]"); return { id: "fixture-learning", text: JSON.stringify(copy), usage: { input_tokens: 100, output_tokens: 100 } }; });
  const result = await db.creativeRevision.findFirstOrThrow({ where: { itemId: a.itemId } }); expect(JSON.stringify(result.provenance)).toContain("NO_HASHTAGS");
  await manageLearnedSkills(a.scope, { action: "retire-skill", proposalId: skill.id }); expect(await memories(a.scope)).toEqual([]);
  expect(await manageLearnedSkills(a.scope, { action: "reflect-skills" })).toMatchObject({ created: 0 });
 });
 it("rejects a future deliverable violating the learned rule without charging customer credits", async () => {
  const a = await setup(); await activate(a.scope);
  const q = await actOnProduction(a.scope, { action: "quote", itemId: a.itemId, mode: "initial", direction: "Show thoughtful architecture for homeowners." }); const quote = (q as { quote: { id: string } }).quote;
  await actOnProduction(a.scope, { action: "accept", quoteId: quote.id }); await db.job.updateMany({ where: { quoteId: quote.id }, data: { availableAt: new Date(0) } });
  await runOneJob(async () => ({ id: "fixture-violation", text: JSON.stringify({ ...copy, caption: `${copy.caption} #Design` }), usage: { input_tokens: 100, output_tokens: 100 } }));
  expect(await db.creativeRevision.count({ where: { itemId: a.itemId } })).toBe(0); expect((await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } })).available).toBe(500);
 });
 it.each(["copy", "approval", "age", "brand", "memory"])("stops using learned skills when %s changes", async kind => {
  const a = await setup(); const skill = await activate(a.scope);
  if (kind === "copy") await db.creativeRevision.update({ where: { id: a.revisions[0] }, data: { content: { ...copy, caption: "Changed text" } } });
  if (kind === "approval") await db.creativeRevision.update({ where: { id: a.revisions[0] }, data: { status: "REJECTED" } });
  if (kind === "age") await db.creativeRevision.update({ where: { id: a.revisions[0] }, data: { approvedAt: new Date(Date.now() - 91 * 86400000) } });
  if (kind === "brand") await db.business.update({ where: { id: a.scope.businessId }, data: { version: 2 } });
  if (kind === "memory") await db.memory.deleteMany({ where: { businessId: a.scope.businessId } });
  const effective = await db.$transaction(tx => productionMemories(tx, a.scope, kind === "brand" ? 2 : 1)); expect(effective).toEqual([]);
  if (kind !== "memory") expect((await readLearnedSkills(a.scope)).skills.find(s => s.id === skill.id)?.valid).toBe(false);
 });
 it("denies foreign proposals and viewer mutations", async () => {
  const a = await setup(), b = await setup(); const skill = await activate(a.scope);
  await expect(manageLearnedSkills(b.scope, { action: "retire-skill", proposalId: skill.id })).rejects.toThrow("not found");
  await db.membership.updateMany({ where: { organizationId: b.scope.organizationId }, data: { role: "VIEWER" } });
  await expect(manageLearnedSkills(b.scope, { action: "reflect-skills" })).rejects.toThrow("role"); expect((await readLearnedSkills(b.scope)).canEdit).toBe(false);
 });
});
