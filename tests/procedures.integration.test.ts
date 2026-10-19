import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { manageProcedures, readProcedures } from "../src/lib/harness/procedures";
import { runOneProcedureReflection } from "../src/lib/harness/procedure-worker";
import { procedureEpisodes, procedureText, redactEpisode, validateProcedures } from "../src/lib/harness/procedure-evidence";
import { businessKnowledge, graphPrompt } from "../src/lib/harness/knowledge-graph";
import { heartbeat } from "../src/lib/production/readiness";
import { manageBrandAnalysis } from "../src/lib/knowledge/analysis";
import { recoverBrandAnalysisLeases } from "../src/lib/knowledge/analysis-worker";
import { reconcileBrandAnalysis } from "../src/lib/knowledge/reconcile";
import { applyPilotCredit } from "../src/lib/billing/pilot-credit";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local fixtures only");
suite("semantic creative reflection lifecycle", () => {
 const orgs: string[] = [], users: string[] = [], worker = `reflection-${crypto.randomUUID()}`;
 beforeAll(async () => {
  vi.stubEnv("PAID_EXECUTION_ENABLED", "true"); vi.stubEnv("OPENAI_API_KEY", "fixture-not-live");
  vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "50000000"); vi.stubEnv("TOTAL_SUPPLIER_BUDGET_MICROS", "1000000000");
  vi.stubEnv("REASONING_RATE_CARD_JSON", JSON.stringify(["creative", "routine"].map(lane => ({ provider: "openai", model: `FIXTURE-${lane}`, lane, inputUsdPerMillion: 1, outputUsdPerMillion: 1, verifiedUntil: "2099-01-01T00:00:00Z" })))); await heartbeat(worker);
 });
 afterAll(async () => {
  const jobs = await db.brandAnalysis.findMany({ where: { organizationId: { in: orgs } }, select: { id: true } });
  await db.supplierAuthorization.deleteMany({ where: { key: { in: jobs.map(j => j.id) } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.user.deleteMany({ where: { id: { in: users } } }); await db.workerHeartbeat.deleteMany({ where: { id: worker } }); vi.unstubAllEnvs(); await db.$disconnect();
 });
 async function setup(count = 2) {
  const org = await db.organization.create({ data: { name: "Reflection fixtures", wallet: { create: { available: 500 } } } }); orgs.push(org.id);
  const user = await db.user.create({ data: { name: "Reviewer", email: `${crypto.randomUUID()}@example.test`, passwordHash: "not-login", memberships: { create: { organizationId: org.id, role: "OWNER" } } } }); users.push(user.id);
  const business = await db.business.create({ data: { organizationId: org.id, name: "Design practice", offering: "Design consultations", audience: "Homeowners", goal: "Book consultations", confirmedAt: new Date() } });
  const scope = { organizationId: org.id, businessId: business.id, actorId: user.id };
  const plan = await db.productionPlan.create({ data: { organizationId: org.id, businessId: business.id, brandVersion: 1, title: "Lessons", creditCeiling: 100 } });
  const content = { headline: "Design with care", caption: "Consider the details of your home.", cta: "Meet us", visualDirection: "Use quiet natural lighting and generous space.", rationale: "Specific brand offering", evidenceUsed: [] };
  for (let i = 0; i < count; i++) await db.productionItem.create({ data: { organizationId: org.id, planId: plan.id, title: "Corrected", format: "static", channel: "LinkedIn", brief: {}, revisions: { create: [
   { version: 1, status: "SUPERSEDED", content: { ...content, caption: "Our designs are awesome!" }, feedback: "Please lead with a thoughtful detail, not loud self-praise. Use quiet natural lighting." },
   { version: 2, status: "APPROVED", content, approvedAt: new Date(), approvedBy: user.id },
  ] } } });
  return { scope, user };
 }
 async function candidate(scope: Awaited<ReturnType<typeof setup>>["scope"], task: "copy" | "image" | "video" = "copy") {
  const episodes = await procedureEpisodes(db, scope, 1);
  return { channel: "LinkedIn" as const, task, scenario: "When presenting design work", instruction: "Lead with a thoughtful concrete detail rather than self-praise.", limitation: "Use only confirmed business facts; visual direction is not rendered-media validation.", reviewCheck: "Check the opening is specific and the tone is restrained.", examples: episodes.map(e => ({ id: e.id, feedbackQuote: "Please lead with a thoughtful detail", approvedQuote: task === "copy" ? "Consider the details of your home." : "Use quiet natural lighting" })) };
 }
 async function quote(scope: Awaited<ReturnType<typeof setup>>["scope"]) {
  await heartbeat(worker); const q = await manageProcedures(scope, { action: "quote", channel: "LinkedIn" }); return (q as { analysisId: string }).analysisId;
 }
 async function reflect(scope: Awaited<ReturnType<typeof setup>>["scope"], task: "copy" | "image" | "video" = "copy") {
  const analysisId = await quote(scope), c = await candidate(scope, task); await manageProcedures(scope, { action: "accept", analysisId });
  await runOneProcedureReflection(async (_provider, req) => { expect(req.system).toContain("untrusted DATA"); expect(req.input).toContain("thoughtful detail"); return { id: "fixture-reflection", text: JSON.stringify({ procedures: [c] }), usage: { input_tokens: 100, output_tokens: 100 } }; });
  const p = (await readProcedures(scope)).procedures.find(p => p.status === "PROCEDURE_PROPOSED")!; expect(p).toBeTruthy(); return { p, analysisId };
 }
 it("requires distinct approved corrections and explicit authorization before AI", async () => {
  const a = await setup(1); await expect(quote(a.scope)).rejects.toThrow("two different");
  const b = await setup(), id = await quote(b.scope), mock = vi.fn(); expect(await runOneProcedureReflection(mock)).toBe(false); expect(mock).not.toHaveBeenCalled();
  expect((await db.wallet.findUniqueOrThrow({ where: { organizationId: b.scope.organizationId } })).held).toBe(0);
  await expect(manageBrandAnalysis(b.scope, { action: "accept", analysisId: id })).rejects.toThrow("not found");
 });
 it.each(["copy", "image", "video"] as const)("proposes, activates, recalls and retires a %s procedure with evidence", async task => {
  const a = await setup(), { p } = await reflect(a.scope, task);
  expect(graphPrompt(await businessKnowledge(db, a.scope, task, "LinkedIn"))).not.toContain("Reviewed creative procedure");
  await expect(manageProcedures(a.scope, { action: "activate", proposalId: p.id })).rejects.toThrow();
  await manageProcedures(a.scope, { action: "activate", proposalId: p.id, reviewedEvidence: true, replaceCurrent: true });
  const graph = await businessKnowledge(db, a.scope, task, "LinkedIn"); expect(graphPrompt(graph)).toContain("thoughtful concrete detail"); expect(graph.edges.some(e => e.relation === "SUPPORTED_BY")).toBe(true);
  expect(graphPrompt(await businessKnowledge(db, a.scope, task, "Instagram"))).not.toContain("thoughtful concrete detail");
  expect(graphPrompt(await businessKnowledge(db, a.scope, "planning", "LinkedIn"))).not.toContain("thoughtful concrete detail");
  await manageProcedures(a.scope, { action: "retire", proposalId: p.id }); expect(graphPrompt(await businessKnowledge(db, a.scope, task, "LinkedIn"))).not.toContain("thoughtful concrete detail");
 });
 it("rejects invented or repeated source quotations and does not charge the customer", async () => {
  const a = await setup(), id = await quote(a.scope), c = await candidate(a.scope);
  const episodes = await procedureEpisodes(db, a.scope, 1);
  expect(() => validateProcedures({ procedures: [{ ...c, examples: [c.examples[0], c.examples[0]] }] }, episodes)).toThrow();
  c.examples[0].approvedQuote = "Invented statement"; await manageProcedures(a.scope, { action: "accept", analysisId: id });
  await runOneProcedureReflection(async () => ({ id: "fixture-invalid", text: JSON.stringify({ procedures: [c] }), usage: { input_tokens: 100, output_tokens: 100 } }));
  const row = await db.brandAnalysis.findUniqueOrThrow({ where: { id } }); expect(row.status).toBe("FAILED"); expect(row.supplierCostMicros).toBeGreaterThan(0);
  expect((await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } })).available).toBe(500); expect((await readProcedures(a.scope)).procedures).toEqual([]);
 });
 it("withholds a result when the evidence changes during the call", async () => {
  const a = await setup(), id = await quote(a.scope), c = await candidate(a.scope); await manageProcedures(a.scope, { action: "accept", analysisId: id });
  await runOneProcedureReflection(async () => { await db.creativeRevision.update({ where: { id: c.examples[0].id }, data: { status: "REJECTED" } }); return { id: "fixture-stale", text: JSON.stringify({ procedures: [c] }), usage: { input_tokens: 100, output_tokens: 100 } }; });
  expect((await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).status).toBe("STALE"); expect((await readProcedures(a.scope)).procedures).toEqual([]);
 });
 it("holds uncertain provider calls without retry and permits audited reconciliation", async () => {
  const a = await setup(), id = await quote(a.scope); await manageProcedures(a.scope, { action: "accept", analysisId: id });
  const mock = vi.fn(async () => { throw Error("Lost response"); }); await runOneProcedureReflection(mock); await recoverBrandAnalysisLeases(); await runOneProcedureReflection(mock); expect(mock).toHaveBeenCalledTimes(1);
  expect((await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).status).toBe("NEEDS_RECONCILIATION");
  await reconcileBrandAnalysis({ analysisId: id, supplierCostMicros: 100, evidence: "Synthetic verified supplier receipt", operatorId: "fixture-operator" });
  expect((await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } })).available).toBe(500);
 });
 it("cancels queued work, expires recalled evidence and denies foreign/viewer actions", async () => {
  const a = await setup(), b = await setup(), id = await quote(a.scope); await manageProcedures(a.scope, { action: "accept", analysisId: id });
  await expect(manageProcedures(b.scope, { action: "cancel", analysisId: id })).rejects.toThrow("not found");
  await manageProcedures(a.scope, { action: "cancel", analysisId: id }); expect(await runOneProcedureReflection(vi.fn())).toBe(false);
  const { p } = await reflect(a.scope); await manageProcedures(a.scope, { action: "activate", proposalId: p.id, reviewedEvidence: true, replaceCurrent: true });
  await db.creativeRevision.update({ where: { id: p.candidate!.examples[0].id }, data: { approvedAt: new Date(Date.now() - 91 * 86400000) } });
  expect(graphPrompt(await businessKnowledge(db, a.scope, "copy", "LinkedIn"))).not.toContain("Reviewed creative procedure");
  await db.membership.updateMany({ where: { organizationId: b.scope.organizationId }, data: { role: "VIEWER" } });
  await expect(quote(b.scope)).rejects.toThrow("editing");
 });
 it("does not redistill a retired identical lesson, or charge for duplicate proposals", async () => {
  const a = await setup(), { p } = await reflect(a.scope); await manageProcedures(a.scope, { action: "retire", proposalId: p.id });
  const before = await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } }), id = await quote(a.scope), c = await candidate(a.scope);
  await manageProcedures(a.scope, { action: "accept", analysisId: id }); await runOneProcedureReflection(async () => ({ id: "duplicate", text: JSON.stringify({ procedures: [c] }), usage: { input_tokens: 100, output_tokens: 100 } }));
  expect((await readProcedures(a.scope)).procedures).toHaveLength(1); expect((await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } })).available).toBe(before.available);
 });
 it("allocates operator pilot credits exactly once, without opening a signup grant", async () => {
  const a = await setup(), b = await setup(), grant = { id: `fixture-${crypto.randomUUID()}`, email: a.user.email, credits: 100, expiresAt: new Date(Date.now() + 86400000).toISOString() };
  vi.stubEnv("PILOT_CREDIT_GRANTS_JSON", JSON.stringify([grant])); expect(await applyPilotCredit(b.user.id, b.user.authVersion)).toBe(false);
  const outcomes = await Promise.all([applyPilotCredit(a.user.id, a.user.authVersion), applyPilotCredit(a.user.id, a.user.authVersion)]); expect(outcomes.filter(Boolean)).toHaveLength(1);
  expect((await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } })).available).toBe(600);
  vi.stubEnv("PILOT_CREDIT_GRANTS_JSON", JSON.stringify([{ ...grant, credits: 200 }])); await expect(applyPilotCredit(a.user.id, a.user.authVersion)).rejects.toThrow("replay changed");
  vi.stubEnv("PILOT_CREDIT_GRANTS_JSON", "");
 });
 it("redacts common contacts and caps instructions", () => { expect(redactEpisode("Email a@example.test or https://example.test/path")).toBe("Email [email] or [link]"); expect(procedureText({ channel: "LinkedIn", task: "copy", scenario: "About design", instruction: "Be specific", limitation: "No inventions", reviewCheck: "Check facts", examples: [] })).toContain("[copy / LinkedIn]"); });
});
