import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { manageProcedures, readProcedures } from "../src/lib/harness/procedures";
import { runOneProcedureReflection } from "../src/lib/harness/procedure-worker";
import { procedureEpisodes, procedureText, redactEpisode, validateProcedures, validProcedureMemories } from "../src/lib/harness/procedure-evidence";
import { businessKnowledge, graphPrompt } from "../src/lib/harness/knowledge-graph";
import { heartbeat } from "../src/lib/production/readiness";
import { manageBrandAnalysis } from "../src/lib/knowledge/analysis";
import { recoverBrandAnalysisLeases } from "../src/lib/knowledge/analysis-worker";
import { reconcileBrandAnalysis } from "../src/lib/knowledge/reconcile";
import { applyPilotCredit } from "../src/lib/billing/pilot-credit";
import { actOnProduction } from "../src/lib/production/service";
import { runOneJob } from "../src/lib/production/worker";
import * as productionService from "../src/lib/production/service";
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
  const quotes = await db.generationQuote.findMany({ where: { organizationId: { in: orgs } }, select: { id: true } });
  await db.supplierAuthorization.deleteMany({ where: { key: { in: [...jobs, ...quotes].map(j => j.id) } } });
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
 async function threeProcedures() {
  const a = await setup();
  for (const task of ["copy", "image", "video"] as const) {
   const { p } = await reflect(a.scope, task);
   await manageProcedures(a.scope, { action: "activate", proposalId: p.id, reviewedEvidence: true, replaceCurrent: true });
  }
  return a;
 }
 async function countEvidenceReads<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
  return db.$transaction(async tx => {
   const findMany = vi.fn(tx.productionItem.findMany.bind(tx.productionItem));
   const delegate = { ...tx.productionItem, findMany };
   const instrumented = new Proxy(tx, { get: (target, key) => key === "productionItem" ? delegate : Reflect.get(target, key) });
   return { result: await operation(instrumented), calls: findMany.mock.calls };
  });
 }
 it("reads bounded scoped correction history once for three active task procedures", async () => {
  const a = await threeProcedures(), stored = await db.memory.findMany({ where: { businessId: a.scope.businessId } });
  const read = await countEvidenceReads(tx => validProcedureMemories(tx, a.scope, 1, stored));
  expect(read.result.size).toBe(3); expect(read.calls).toHaveLength(1);
  expect(read.calls[0][0]).toMatchObject({ where: { organizationId: a.scope.organizationId, plan: { businessId: a.scope.businessId, organizationId: a.scope.organizationId, brandVersion: 1 } }, take: 100, include: { revisions: { take: 8 } } });
  expect((await readProcedures(a.scope)).procedures.every(p => p.valid)).toBe(true);
 });
 it.each(["modified", "deleted", "expired"] as const)("revalidates %s evidence on the next request, without cross-business reuse", async change => {
  const a = await threeProcedures(), b = await setup(), stored = await db.memory.findMany({ where: { businessId: a.scope.businessId } });
  expect((await countEvidenceReads(tx => validProcedureMemories(tx, a.scope, 1, stored))).result.size).toBe(3);
  const foreign = await countEvidenceReads(tx => validProcedureMemories(tx, b.scope, 1, stored));
  expect(foreign.result.size).toBe(0); expect(foreign.calls).toHaveLength(0);
  const source = (await procedureEpisodes(db, a.scope, 1))[0];
  if (change === "deleted") await db.creativeRevision.delete({ where: { id: source.id } });
  else await db.creativeRevision.update({ where: { id: source.id }, data: change === "expired" ? { approvedAt: new Date(Date.now() - 91 * 86400000) } : { status: "REJECTED" } });
  const changed = await countEvidenceReads(tx => validProcedureMemories(tx, a.scope, 1, stored));
  expect(changed.result.size).toBe(0); expect(changed.calls).toHaveLength(1);
  expect((await readProcedures(a.scope)).procedures.every(p => !p.valid)).toBe(true);
 });
 it("keeps exact retained-memory binding independent from batched evidence", async () => {
  const a = await threeProcedures(), stored = await db.memory.findMany({ where: { businessId: a.scope.businessId }, orderBy: { id: "asc" } });
  await db.memory.delete({ where: { id: stored[0].id } });
  await db.memory.update({ where: { id: stored[1].id }, data: { text: "An unreviewed replacement instruction." } });
  const retained = await db.memory.findMany({ where: { businessId: a.scope.businessId } });
  const read = await countEvidenceReads(tx => validProcedureMemories(tx, a.scope, 1, retained));
  expect([...read.result]).toEqual([stored[2].id]); expect(read.calls).toHaveLength(1);
  expect((await readProcedures(a.scope)).procedures.filter(p => p.valid).map(p => p.instruction)).toEqual([stored[2].text]);
  const wrongKind = await countEvidenceReads(tx => validProcedureMemories(tx, a.scope, 1, retained.map(m => ({ ...m, kind: "PREFERENCE" }))));
  expect(wrongKind.result.size).toBe(0); expect(wrongKind.calls).toHaveLength(0);
 });
 it("fails closed above the twelve-procedure context ceiling without loading evidence", async () => {
  const a = await setup(), { p } = await reflect(a.scope);
  const proposal = await db.learningProposal.findUniqueOrThrow({ where: { id: p.id } });
  for (let i = 0; i < 13; i++) {
   const memory = await db.memory.create({ data: { businessId: a.scope.businessId, organizationId: a.scope.organizationId, kind: "REVIEWED_PROCEDURE", text: proposal.hypothesis } });
   await db.learningProposal.create({ data: { businessId: a.scope.businessId, organizationId: a.scope.organizationId, brandVersion: 1, hypothesis: proposal.hypothesis, evidence: proposal.evidence as Prisma.InputJsonValue, status: "PROCEDURE_ACTIVE", memoryId: memory.id } });
  }
  const stored = await db.memory.findMany({ where: { businessId: a.scope.businessId } });
  const overflow = await countEvidenceReads(tx => validProcedureMemories(tx, a.scope, 1, stored));
  expect(overflow.result.size).toBe(0); expect(overflow.calls).toHaveLength(0);
 });
 it("requires distinct approved corrections and explicit authorization before AI", async () => {
  const a = await setup(1); await expect(quote(a.scope)).rejects.toThrow("two different");
  const b = await setup(), id = await quote(b.scope), mock = vi.fn(); expect(await runOneProcedureReflection(mock)).toBe(false); expect(mock).not.toHaveBeenCalled();
  expect((await db.wallet.findUniqueOrThrow({ where: { organizationId: b.scope.organizationId } })).held).toBe(0);
  await expect(manageBrandAnalysis(b.scope, { action: "accept", analysisId: id })).rejects.toThrow("not found");
 });
 it.each([null, "", " \t\n"])("excludes corrections without a named reviewer (%j) before any reflection quote", async approvedBy => {
  const a = await setup(), before = await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } });
  await db.creativeRevision.updateMany({ where: { organizationId: a.scope.organizationId, status: "APPROVED" }, data: { approvedBy } });
  expect(await procedureEpisodes(db, a.scope, 1)).toEqual([]);
  await expect(quote(a.scope)).rejects.toThrow("two different");
  expect(await db.brandAnalysis.count({ where: { businessId: a.scope.businessId } })).toBe(0);
  expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } })).toEqual(before);
 });
 it("rejects a pending proposal after its source reviewer is removed", async () => {
  const a = await setup(), { p } = await reflect(a.scope);
  await db.creativeRevision.update({ where: { id: p.candidate!.examples[0].id }, data: { approvedBy: " \t\n" } });
  await expect(manageProcedures(a.scope, { action: "activate", proposalId: p.id, reviewedEvidence: true, replaceCurrent: true })).rejects.toThrow("evidence changed");
  expect((await readProcedures(a.scope)).procedures.find(row => row.id === p.id)).toMatchObject({ status: "PROCEDURE_PROPOSED", valid: false });
  expect(graphPrompt(await businessKnowledge(db, a.scope, "copy", "LinkedIn"))).not.toContain("thoughtful concrete detail");
 });
 it("invalidates active recall and queued reflection after reviewer removal", async () => {
  const a = await setup(), { p } = await reflect(a.scope);
  await manageProcedures(a.scope, { action: "activate", proposalId: p.id, reviewedEvidence: true, replaceCurrent: true });
  const id = await quote(a.scope); await manageProcedures(a.scope, { action: "accept", analysisId: id });
  const before = await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } });
  const source = (await procedureEpisodes(db, a.scope, 1))[0];
  await db.creativeRevision.update({ where: { id: source.id }, data: { approvedBy: " \t\n" } });
  expect((await readProcedures(a.scope)).procedures.find(row => row.id === p.id)?.valid).toBe(false);
  expect(graphPrompt(await businessKnowledge(db, a.scope, "copy", "LinkedIn"))).not.toContain("thoughtful concrete detail");
  // Re-activation cannot rehabilitate missing review evidence.
  await expect(manageProcedures(a.scope, { action: "activate", proposalId: p.id, reviewedEvidence: true, replaceCurrent: true })).rejects.toThrow();
  const provider = vi.fn();
  await runOneProcedureReflection(provider); await runOneProcedureReflection(provider);
  expect(provider).not.toHaveBeenCalled();
  expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "FAILED", errorCode: "PREFLIGHT_FAILED", supplierCostMicros: null });
  const after = await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } });
  expect(after.held).toBe(0); expect(after.available + after.held).toBe(before.available + before.held);
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
 it("attributes actual worker output to recalled procedures through review, retirement and manual replacement", async () => {
  const a = await setup(), { p } = await reflect(a.scope), other = await setup();
  await manageProcedures(a.scope, { action: "activate", proposalId: p.id, reviewedEvidence: true, replaceCurrent: true });
  const plan = await db.productionPlan.findFirstOrThrow({ where: { businessId: a.scope.businessId } });
  const item = await db.productionItem.create({ data: { organizationId: a.scope.organizationId, planId: plan.id, title: "Independent later creative", format: "static", channel: "LinkedIn", brief: {} } });
  const read = async () => (await readProcedures(a.scope)).procedures.find(row => row.id === p.id)!.outcomes;
  expect((await read()).delivered).toBe(0);
  const q = await actOnProduction(a.scope, { action: "quote", itemId: item.id, mode: "initial", direction: "Show the value of a considered design consultation." });
  if (!("quote" in q) || !q.quote) throw Error("Missing generation quote");
  await actOnProduction(a.scope, { action: "accept", quoteId: q.quote.id });
  expect((await read()).delivered).toBe(0);
  await db.job.updateMany({ where: { organizationId: a.scope.organizationId, status: "QUEUED", kind: "STATIC_COPY" }, data: { availableAt: new Date(0) } });
  const generated = { headline: "Design with care", caption: "Consider the details of your home.", cta: "Meet us", visualDirection: "Quiet natural lighting and generous space.", rationale: "Specific offering without unsupported claims", evidenceUsed: [] };
  expect(await runOneJob(async (_provider, request) => {
   expect(request.input).toContain("thoughtful concrete detail");
   return { id: "fixture-procedure-output", text: JSON.stringify(generated), usage: { input_tokens: 100, output_tokens: 100 } };
  })).toBe(true);
  expect(await read()).toMatchObject({ delivered: 1, distinctCreatives: 1, awaitingReview: 1, approved: 0 });
  await actOnProduction(a.scope, { action: "approve", itemId: item.id, version: 1 });
  expect(await read()).toMatchObject({ delivered: 1, changesRequested: 0, approved: 1 });
  const retained = await db.creativeRevision.findFirstOrThrow({ where: { itemId: item.id, version: 1 } });
  await db.creativeRevision.update({ where: { id: retained.id }, data: { approvedBy: " \t\n" } });
  expect(await read()).toMatchObject({ delivered: 1, approved: 0, replacedOrUnavailable: 1 });
  await db.creativeRevision.update({ where: { id: retained.id }, data: { approvedBy: retained.approvedBy } });
  expect(await read()).toMatchObject({ delivered: 1, approved: 1, replacedOrUnavailable: 0 });
  await actOnProduction(a.scope, { action: "revise", itemId: item.id, version: 1, feedback: "Keep the opening but make the next sentence clearer." });
  expect(await read()).toMatchObject({ delivered: 1, changesRequested: 1, awaitingReview: 0 });
  expect((await readProcedures(other.scope)).procedures).toEqual([]);
  await expect(readProcedures({ ...a.scope, actorId: other.user.id })).rejects.toThrow();
  await manageProcedures(a.scope, { action: "retire", proposalId: p.id });
  expect(await read()).toMatchObject({ delivered: 1, changesRequested: 1 });
  await actOnProduction(a.scope, { action: "edit", itemId: item.id, version: 1, headline: "A considered home", caption: generated.caption, cta: generated.cta });
  expect(await read()).toMatchObject({ delivered: 1, approved: 0, replacedOrUnavailable: 1 });
 });
 it("withholds a result when the evidence changes during the call", async () => {
  const a = await setup(), id = await quote(a.scope), c = await candidate(a.scope); await manageProcedures(a.scope, { action: "accept", analysisId: id });
  await runOneProcedureReflection(async () => { await db.creativeRevision.update({ where: { id: c.examples[0].id }, data: { status: "REJECTED" } }); return { id: "fixture-stale", text: JSON.stringify({ procedures: [c] }), usage: { input_tokens: 100, output_tokens: 100 } }; });
  expect((await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).status).toBe("STALE"); expect((await readProcedures(a.scope)).procedures).toEqual([]);
 });
 it.each(["lease", "sources", "route", "actor", "recovered"] as const)("does not deliver or settle a reflection after its %s ownership changes", async change => {
  const a = await setup(), id = await quote(a.scope), c = await candidate(a.scope);
  await manageProcedures(a.scope, { action: "accept", analysisId: id });
  const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } });
  let retained: Awaited<ReturnType<typeof db.brandAnalysis.findUniqueOrThrow>> | undefined;
  const provider = vi.fn(async () => {
   const row = await db.brandAnalysis.findUniqueOrThrow({ where: { id } });
   if (change === "lease") await db.brandAnalysis.update({ where: { id }, data: { leaseUntil: new Date(row.leaseUntil!.getTime() + 1000) } });
   if (change === "sources") await db.brandAnalysis.update({ where: { id }, data: { sources: [...(row.sources as Prisma.JsonArray)].reverse() } });
   if (change === "route") await db.brandAnalysis.update({ where: { id }, data: { route: { ...(row.route as Prisma.JsonObject), credits: row.credits + 1 } } });
   if (change === "actor") await db.brandAnalysis.update({ where: { id }, data: { actorId: "different-author" } });
   if (change === "recovered") {
    await db.brandAnalysis.update({ where: { id }, data: { leaseUntil: new Date(0) } });
    await recoverBrandAnalysisLeases();
   }
   retained = await db.brandAnalysis.findUniqueOrThrow({ where: { id } });
   return { id: "fixture-late", text: JSON.stringify({ procedures: [c] }), usage: { input_tokens: 100, output_tokens: 100 } };
  });
  await runOneProcedureReflection(provider); await runOneProcedureReflection(provider);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).toEqual(retained);
  expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } })).toEqual(wallet);
  expect(await db.learningProposal.count({ where: { businessId: a.scope.businessId } })).toBe(0);
 });
 it.each(["lease", "sources", "elapsed"] as const)("checks reflection %s ownership before provider submission", async change => {
  const a = await setup(), id = await quote(a.scope);
  await manageProcedures(a.scope, { action: "accept", analysisId: id });
  const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } });
  const original = productionService.lockBusiness;
  let restoreClock = () => {};
  const spy = vi.spyOn(productionService, "lockBusiness").mockImplementationOnce(async (tx, scope) => {
   const row = await db.brandAnalysis.findUniqueOrThrow({ where: { id } });
   if (change === "elapsed") {
    const clock = vi.spyOn(Date, "now").mockReturnValue(row.leaseUntil!.getTime() + 1);
    restoreClock = () => clock.mockRestore();
   } else await db.brandAnalysis.update({ where: { id }, data: change === "lease" ? { leaseUntil: new Date(row.leaseUntil!.getTime() + 1000) } : { sources: [...(row.sources as Prisma.JsonArray)].reverse() } });
   return original(tx, scope);
  });
  const provider = vi.fn();
  try { await runOneProcedureReflection(provider); } finally { spy.mockRestore(); restoreClock(); }
  expect(provider).not.toHaveBeenCalled();
  expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: change === "elapsed" ? "FAILED" : "RUNNING", submittedAt: null });
  const after = await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } });
  if (change === "elapsed") expect(after).toMatchObject({ available: 500, held: 0 });
  else expect(after).toEqual(wallet);
  // Prevent a later recovery fixture from requeueing this synthetic replacement.
  await db.brandAnalysis.update({ where: { id }, data: { status: "CANCELLED", leaseUntil: null } });
 });
 it("does not overwrite a recovered reflection when the old provider call throws", async () => {
  const a = await setup(), id = await quote(a.scope);
  await manageProcedures(a.scope, { action: "accept", analysisId: id });
  const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } });
  await runOneProcedureReflection(async () => {
   await db.brandAnalysis.update({ where: { id }, data: { leaseUntil: new Date(0) } });
   await recoverBrandAnalysisLeases();
   throw Error("Synthetic old transport failure");
  });
  expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", errorCode: "LEASE_EXPIRED_AFTER_SUBMISSION" });
  expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } })).toEqual(wallet);
 });
 it("fences elapsed reflection leases even before recovery runs", async () => {
  const a = await setup(), id = await quote(a.scope), c = await candidate(a.scope);
  await manageProcedures(a.scope, { action: "accept", analysisId: id });
  const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } });
  const clock = vi.spyOn(Date, "now");
  try {
   await runOneProcedureReflection(async () => {
    const row = await db.brandAnalysis.findUniqueOrThrow({ where: { id } });
    clock.mockReturnValue(row.leaseUntil!.getTime() + 1);
    return { id: "fixture-expired", text: JSON.stringify({ procedures: [c] }), usage: { input_tokens: 100, output_tokens: 100 } };
   });
  } finally { clock.mockRestore(); }
  expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", errorCode: "PROVIDER_OUTCOME_UNKNOWN", supplierCostMicros: null, leaseUntil: null });
  expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: a.scope.organizationId } })).toEqual(wallet);
  expect(await db.learningProposal.count({ where: { businessId: a.scope.businessId } })).toBe(0);
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
