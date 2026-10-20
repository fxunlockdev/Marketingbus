import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { actOnProduction } from "../src/lib/production/service";
import { manageApprovals, readApprovals } from "../src/lib/workflows/approvals";
import { savePlanning, createDuePlan, runOneWeeklyDraft, nextWeekly, weekKey, cancelWeeklyCycle, readPlanning } from "../src/lib/workflows/planning";
import { heartbeat } from "../src/lib/production/readiness";
import * as knowledge from "../src/lib/harness/knowledge-graph";
import { AppError } from "../src/lib/http";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local fixture database required");
suite("approval policy, comments and bounded recurring work", () => {
  const orgs: string[] = [], users: string[] = [], workerId = crypto.randomUUID();
  beforeAll(async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-no-network"); vi.stubEnv("PAID_EXECUTION_ENABLED", "true"); vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "100000000"); vi.stubEnv("TOTAL_SUPPLIER_BUDGET_MICROS", "1000000000");
    vi.stubEnv("REASONING_RATE_CARD_JSON", JSON.stringify([{ provider: "openai", model: "FIXTURE", lane: "creative", inputUsdPerMillion: 0.01, outputUsdPerMillion: 0.01, verifiedUntil: "2099-01-01T00:00:00Z" }]));
    await heartbeat(workerId);
  });
  afterAll(async () => {
    const quotes = await db.generationQuote.findMany({ where: { organizationId: { in: orgs } } });
    await db.supplierAuthorization.deleteMany({ where: { key: { in: quotes.map(q => q.id) } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.user.deleteMany({ where: { id: { in: users } } }); await db.workerHeartbeat.deleteMany({ where: { id: workerId } }); vi.unstubAllEnvs(); await db.$disconnect();
  });
  afterEach(async () => {
    await db.weeklyPolicy.updateMany({ where: { organizationId: { in: orgs } }, data: { enabled: false } });
    await db.weeklyCycle.updateMany({ where: { organizationId: { in: orgs }, status: "OPEN" }, data: { status: "CANCELLED", leaseUntil: null } });
  });
  async function setup() {
    const actors = await Promise.all(["OWNER", "ADMIN", "EDITOR"].map(async role => { const user = await db.user.create({ data: { name: role, email: `${crypto.randomUUID()}@example.test`, passwordHash: "fixture" } }); users.push(user.id); return { userId: user.id, role }; }));
    const org = await db.organization.create({ data: { name: "WORKFLOW FIXTURE", wallet: { create: { available: 1000 } }, memberships: { create: actors } } }); orgs.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Architecture Studio", offering: "Design consultations", audience: "Homeowners", goal: "Book consultations", channels: ["Facebook"], confirmedAt: new Date() } });
    const scope = { businessId: business.id, organizationId: org.id, actorId: actors[0].userId };
    const plan = await db.productionPlan.create({ data: { businessId: business.id, organizationId: org.id, title: "Test", brandVersion: 1, creditCeiling: 0, items: { create: { title: "Test creative", channel: "Facebook", format: "static", brief: {}, revisions: { create: { version: 1, status: "READY", authorId: scope.actorId, content: { headline: "Made for home", caption: "Considered architecture for your home.", cta: "Meet us", visualDirection: "Approved typography", rationale: "Test", evidenceUsed: [] } } } } } }, include: { items: { include: { revisions: true } } } });
    return { scope, admin: { ...scope, actorId: actors[1].userId }, editor: { ...scope, actorId: actors[2].userId }, item: plan.items[0] };
  }
  const policy = { enabled: true, mode: "PLAN", maxItems: 3, creditsPerWeek: 0, weekday: 1, hourUTC: 9, version: 0 };
  async function due(businessId: string) { await db.weeklyPolicy.update({ where: { businessId }, data: { nextRunAt: new Date(Date.now() - 1000) } }); }
  it("requires a different privileged approver and revokes existing schedules on policy change", async () => {
    const c = await setup(), action = { action: "approve", itemId: c.item.id, version: 1 };
    await actOnProduction(c.scope, action);
    await actOnProduction(c.scope, { action: "schedule", itemId: c.item.id, version: 1, scheduledFor: new Date(Date.now() + 120000).toISOString(), timezone: "UTC" });
    await expect(manageApprovals(c.editor, { action: "policy", independent: true })).rejects.toThrow("Administrator");
    await manageApprovals(c.scope, { action: "policy", independent: true });
    expect(await db.calendarEntry.count({ where: { itemId: c.item.id } })).toBe(0);
    await expect(actOnProduction(c.scope, action)).rejects.toThrow("different person");
    await expect(actOnProduction(c.editor, action)).rejects.toThrow("administrator");
    await actOnProduction(c.admin, action);
    expect((await db.creativeRevision.findUniqueOrThrow({ where: { id: c.item.revisions[0].id } })).approvedBy).toBe(c.admin.actorId);
  });
  it("blocking comments revoke approval, restrict resolution and cannot leak across businesses", async () => {
    const c = await setup(), other = await setup(), action = { action: "approve", itemId: c.item.id, version: 1 };
    await actOnProduction(c.scope, action);
    await manageApprovals(c.admin, { action: "comment", itemId: c.item.id, version: 1, body: "Check the audience wording", blocking: true });
    await expect(actOnProduction(c.scope, action)).rejects.toThrow("blocking review");
    const comment = (await readApprovals(c.scope, c.item.id)).comments[0];
    await expect(manageApprovals(c.editor, { action: "resolve", commentId: comment.id })).rejects.toThrow("commenter");
    await expect(manageApprovals(other.scope, { action: "resolve", commentId: comment.id })).rejects.toThrow("not found");
    await manageApprovals(c.admin, { action: "resolve", commentId: comment.id });
    expect((await db.creativeRevision.findUniqueOrThrow({ where: { id: c.item.revisions[0].id } })).status).toBe("READY");
    await actOnProduction(c.scope, action);
  });
  it("creates one bounded plan per week under concurrent ticks and never resets it through settings", async () => {
    const c = await setup(); await savePlanning(c.scope, policy); await due(c.scope.businessId);
    await Promise.all([createDuePlan(), createDuePlan()]);
    const cycles = await db.weeklyCycle.findMany({ where: { businessId: c.scope.businessId }, include: { tasks: true } });
    expect(cycles).toHaveLength(1); expect(cycles[0].tasks).toHaveLength(3); expect(cycles[0].status).toBe("COMPLETE");
    expect(await db.job.count({ where: { businessId: c.scope.businessId } })).toBe(0);
    await savePlanning(c.scope, { ...policy, version: 1, maxItems: 9 }); await due(c.scope.businessId); await createDuePlan();
    expect(await db.weeklyCycle.count({ where: { businessId: c.scope.businessId } })).toBe(1);
    await expect(savePlanning(c.scope, { ...policy, version: 1 })).rejects.toThrow("changed");
  });
  it("pauses after brand or authorizer changes and rejects editor opt-in", async () => {
    const c = await setup(); await expect(savePlanning(c.editor, policy)).rejects.toThrow("administrators");
    await savePlanning(c.scope, policy); await due(c.scope.businessId);
    await db.business.update({ where: { id: c.scope.businessId }, data: { version: 2 } }); await createDuePlan();
    expect((await db.weeklyPolicy.findUniqueOrThrow({ where: { businessId: c.scope.businessId } })).enabled).toBe(false);
    expect((await readPlanning(c.scope)).pauseNotice?.message).toContain("brand changed");
    expect(await db.weeklyCycle.count({ where: { businessId: c.scope.businessId } })).toBe(0);
  });
  it.each(["count", "length", "total", "brand"])("isolates invalid %s planning context without starving another tenant", async reason => {
    const blocked = await setup(), healthy = await setup();
    for (const c of [blocked, healthy]) await savePlanning(c.scope, { ...policy, mode: "DRAFTS", creditsPerWeek: 20 });
    await db.weeklyPolicy.update({ where: { businessId: blocked.scope.businessId }, data: { nextRunAt: new Date(0) } });
    await db.weeklyPolicy.update({ where: { businessId: healthy.scope.businessId }, data: { nextRunAt: new Date(1) } });
    if (reason === "brand") await db.business.update({ where: { id: blocked.scope.businessId }, data: { offering: "" } });
    else await db.memory.createMany({ data: Array.from({ length: reason === "count" ? 31 : reason === "total" ? 7 : 1 }, (_, i) => ({
      organizationId: blocked.scope.organizationId, businessId: blocked.scope.businessId, kind: "EXPLICIT_PREFERENCE",
      text: `PRIVATE-CONTEXT-${i}-`.padEnd(reason === "length" ? 1001 : reason === "total" ? 900 : 30, "x"),
    })) });
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: blocked.scope.organizationId } });
    await expect(createDuePlan()).resolves.toBe(true);
    expect((await readPlanning(blocked.scope)).policy?.enabled).toBe(false);
    expect((await readPlanning(blocked.scope)).pauseNotice?.message).toContain("consolidate saved preferences");
    expect((await db.weeklyPolicy.findUniqueOrThrow({ where: { businessId: blocked.scope.businessId } })).pauseReason).toBe("CONTEXT_INVALID");
    expect(await db.weeklyCycle.count({ where: { businessId: blocked.scope.businessId } })).toBe(0);
    expect(await db.productionPlan.count({ where: { businessId: blocked.scope.businessId } })).toBe(1);
    const audit = await db.auditEvent.findMany({ where: { businessId: blocked.scope.businessId, action: "WEEKLY_POLICY_PAUSED" } });
    expect(audit).toHaveLength(1); expect(audit[0].detail).not.toContain("PRIVATE-CONTEXT");
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: blocked.scope.organizationId } })).toEqual(wallet);
    expect(await db.generationQuote.count({ where: { businessId: blocked.scope.businessId } })).toBe(0);
    expect(await db.job.count({ where: { businessId: blocked.scope.businessId } })).toBe(0);
    await expect(createDuePlan()).resolves.toBe(true);
    expect(await db.weeklyCycle.count({ where: { businessId: healthy.scope.businessId } })).toBe(1);
    expect((await readPlanning(healthy.scope)).policy?.enabled).toBe(true);
    expect(await createDuePlan()).toBe(false);
    // Fixing evidence alone cannot silently reauthorize a paused policy.
    await db.memory.deleteMany({ where: { businessId: blocked.scope.businessId } });
    await db.business.update({ where: { id: blocked.scope.businessId }, data: { offering: "Design consultations" } });
    expect(await createDuePlan()).toBe(false);
    await expect(savePlanning(blocked.editor, { ...policy, version: 1 })).rejects.toThrow("administrators");
    await savePlanning(blocked.admin, { ...policy, version: 1 });
    expect((await readPlanning(blocked.scope)).pauseNotice).toBeNull();
    expect((await db.weeklyPolicy.findUniqueOrThrow({ where: { businessId: blocked.scope.businessId } })).pauseReason).toBeNull();
    await due(blocked.scope.businessId); await createDuePlan();
    expect(await db.weeklyCycle.count({ where: { businessId: blocked.scope.businessId } })).toBe(1);
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: blocked.scope.organizationId } })).toEqual(wallet);
  });
  it("projects safe pause guidance without exposing audit content or crossing tenant boundaries", async () => {
    const c = await setup(), other = await setup();
    expect((await readPlanning(c.scope)).pauseNotice).toBeNull();
    await savePlanning(c.scope, policy); await due(c.scope.businessId);
    await db.membership.update({ where: { organizationId_userId: { organizationId: c.scope.organizationId, userId: c.scope.actorId } }, data: { role: "EDITOR" } });
    await createDuePlan();
    await db.auditEvent.create({ data: { ...c.scope, action: "WEEKLY_POLICY_PAUSED", detail: "PRIVATE-RAW-CONTEXT-AND-ERROR" } });
    const result = await readPlanning(c.editor);
    expect(result.canManage).toBe(false);
    expect(result.pauseNotice?.message).toContain("previous authorizer");
    expect(result.policy).not.toHaveProperty("pauseReason");
    expect(JSON.stringify(result)).not.toContain("PRIVATE-RAW");
    await expect(readPlanning({ ...other.scope, businessId: c.scope.businessId })).rejects.toThrow("not found");
    await expect(readPlanning({ ...c.scope, actorId: other.scope.actorId })).rejects.toThrow("not found");
    await expect(savePlanning(c.editor, { ...policy, version: 1 })).rejects.toThrow("administrators");
    await expect(savePlanning(c.admin, { ...policy, version: 0 })).rejects.toThrow("changed");
    expect((await readPlanning(c.admin)).pauseNotice).toEqual(result.pauseNotice);
    await savePlanning(c.admin, { ...policy, version: 1 });
    expect((await readPlanning(c.admin)).pauseNotice).toBeNull();
  });
  it("keeps manual and legacy disabled policies truthful without inferring an old audit reason", async () => {
    const c = await setup();
    await savePlanning(c.scope, { ...policy, enabled: false });
    await db.auditEvent.create({ data: { ...c.scope, action: "WEEKLY_POLICY_PAUSED", detail: "Brand or authorizing membership changed; administrator confirmation required." } });
    expect((await readPlanning(c.scope)).pauseNotice?.message).toBe("Recurring work is disabled. Review your brand and settings before enabling it.");
    await expect(savePlanning(c.scope, { ...policy, version: 1, pauseReason: "CONTEXT_INVALID" })).rejects.toThrow();
    expect((await db.weeklyPolicy.findUniqueOrThrow({ where: { businessId: c.scope.businessId } })).pauseReason).toBeNull();
    await savePlanning(c.scope, { ...policy, version: 1 });
    expect((await readPlanning(c.scope)).pauseNotice).toBeNull();
  });
  it("restricts persisted pause reasons to code-owned values", async () => {
    const c = await setup(); await savePlanning(c.scope, policy);
    await expect(db.weeklyPolicy.update({ where: { businessId: c.scope.businessId }, data: { pauseReason: "PRIVATE-UNSAFE-ERROR" } })).rejects.toThrow();
    expect((await db.weeklyPolicy.findUniqueOrThrow({ where: { businessId: c.scope.businessId } })).pauseReason).toBeNull();
  });
  it("reserves weekly ceilings atomically with job creation, then stops without auto-retry", async () => {
    const c = await setup(); await savePlanning(c.scope, { ...policy, mode: "DRAFTS", maxItems: 2, creditsPerWeek: 1 }); await due(c.scope.businessId); await createDuePlan();
    await Promise.all([runOneWeeklyDraft(), runOneWeeklyDraft()]);
    await runOneWeeklyDraft();
    const cycle = await db.weeklyCycle.findFirstOrThrow({ where: { businessId: c.scope.businessId }, include: { tasks: true } });
    expect(cycle.creditsAuthorized).toBe(1); expect(cycle.status).toBe("BLOCKED");
    expect(cycle.tasks.filter(t => t.status === "AUTHORIZED")).toHaveLength(1);
    expect(await db.job.count({ where: { businessId: c.scope.businessId } })).toBe(1);
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: c.scope.organizationId } }); expect(wallet.held).toBe(1);
    await runOneWeeklyDraft(); expect(await db.job.count({ where: { businessId: c.scope.businessId } })).toBe(1);
  });
  it("pauses invalid context only once under overlapping planner ticks", async () => {
    const c = await setup(); await savePlanning(c.scope, policy); await due(c.scope.businessId);
    await db.business.update({ where: { id: c.scope.businessId }, data: { audience: "" } });
    await Promise.all([createDuePlan(), createDuePlan(), createDuePlan()]);
    expect((await readPlanning(c.scope)).policy?.enabled).toBe(false);
    expect(await db.auditEvent.count({ where: { businessId: c.scope.businessId, action: "WEEKLY_POLICY_PAUSED" } })).toBe(1);
    expect(await db.weeklyCycle.count({ where: { businessId: c.scope.businessId } })).toBe(0);
  });
  it.each([new Error("fixture transport failure"), new AppError(503, "fixture database unavailable")])("does not turn infrastructure failure into revoked customer consent: %s", async failure => {
    const c = await setup(); await savePlanning(c.scope, policy); await due(c.scope.businessId);
    const before = await db.weeklyPolicy.findUniqueOrThrow({ where: { businessId: c.scope.businessId } });
    const recall = vi.spyOn(knowledge, "businessKnowledge").mockRejectedValueOnce(failure);
    try { await expect(createDuePlan()).rejects.toThrow(failure.message); } finally { recall.mockRestore(); }
    expect(await db.weeklyPolicy.findUniqueOrThrow({ where: { businessId: c.scope.businessId } })).toEqual(before);
    expect(await db.auditEvent.count({ where: { businessId: c.scope.businessId, action: "WEEKLY_POLICY_PAUSED" } })).toBe(0);
    await createDuePlan();
    expect(await db.weeklyCycle.count({ where: { businessId: c.scope.businessId } })).toBe(1);
  });
  it("handles UTC week/year boundaries without local DST ambiguity", () => {
    expect(weekKey(new Date("2027-01-01T23:00:00Z"))).toBe("2026-12-28");
    expect(nextWeekly(1, 9, new Date("2026-10-19T09:00:00Z")).toISOString()).toBe("2026-10-26T09:00:00.000Z");
  });
  async function draftCycle() {
    const c = await setup(); await savePlanning(c.scope, { ...policy, mode: "DRAFTS", maxItems: 2, creditsPerWeek: 10 }); await due(c.scope.businessId); await createDuePlan();
    const cycle = await db.weeklyCycle.findFirstOrThrow({ where: { businessId: c.scope.businessId }, include: { tasks: { orderBy: { id: "asc" } } } });
    return { ...c, cycle, cancel: { action: "cancelCycle", cycleId: cycle.id, policyVersion: cycle.policyVersion } };
  }
  it("invalid next-week context preserves previously authorized jobs, held credits and supplier exposure", async () => {
    const c = await draftCycle(); await runOneWeeklyDraft();
    await db.weeklyCycle.update({ where: { id: c.cycle.id }, data: { periodKey: "2020-01-06" } });
    const priorCycle = await db.weeklyCycle.findUniqueOrThrow({ where: { id: c.cycle.id }, include: { tasks: true } });
    const jobs = await db.job.findMany({ where: { businessId: c.scope.businessId } });
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: c.scope.organizationId } });
    const supplier = await db.supplierAuthorization.findMany({ where: { key: { in: jobs.flatMap(j => j.quoteId ? [j.quoteId] : []) } } });
    await db.memory.create({ data: { businessId: c.scope.businessId, organizationId: c.scope.organizationId, text: "x".repeat(1001) } });
    await due(c.scope.businessId); await createDuePlan();
    expect((await readPlanning(c.scope)).policy?.enabled).toBe(false);
    expect(await db.weeklyCycle.findUniqueOrThrow({ where: { id: c.cycle.id }, include: { tasks: true } })).toEqual(priorCycle);
    expect(await db.job.findMany({ where: { businessId: c.scope.businessId } })).toEqual(jobs);
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: c.scope.organizationId } })).toEqual(wallet);
    expect(await db.supplierAuthorization.findMany({ where: { key: { in: supplier.map(s => s.key) } } })).toEqual(supplier);
    expect(await db.weeklyCycle.count({ where: { businessId: c.scope.businessId } })).toBe(1);
  });
  it("stops only the selected run, revokes unaccepted quotes and preserves future policy and spend counters", async () => {
    const c = await draftCycle(), task = c.cycle.tasks[0];
    const result = await actOnProduction(c.scope, { action: "quote", itemId: task.itemId, mode: "initial", direction: "Use confirmed brand facts only in this synthetic fixture." });
    if (!("quote" in result) || !result.quote) throw Error("Expected quote");
    await db.weeklyTask.update({ where: { id: task.id }, data: { status: "QUOTED", quoteId: result.quote.id } });
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: c.scope.organizationId } });
    await Promise.all([cancelWeeklyCycle(c.scope, c.cancel), cancelWeeklyCycle(c.admin, c.cancel)]);
    const row = await db.weeklyCycle.findUniqueOrThrow({ where: { id: c.cycle.id }, include: { tasks: true } });
    expect(row.status).toBe("CANCELLED"); expect(row.creditsAuthorized).toBe(0); expect(row.tasks.every(t => t.status === "CANCELLED")).toBe(true);
    expect((await db.generationQuote.findUniqueOrThrow({ where: { id: result.quote.id } })).status).toBe("CANCELLED");
    await expect(actOnProduction(c.scope, { action: "accept", quoteId: result.quote.id })).rejects.toThrow("expired or changed");
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: c.scope.organizationId } })).toEqual(wallet);
    expect((await db.weeklyPolicy.findUniqueOrThrow({ where: { businessId: c.scope.businessId } })).enabled).toBe(true);
    expect(await db.auditEvent.count({ where: { businessId: c.scope.businessId, action: "WEEKLY_RUN_CANCELLED" } })).toBe(1);
    await due(c.scope.businessId); await createDuePlan(); expect(await db.weeklyCycle.count({ where: { businessId: c.scope.businessId } })).toBe(1);
  });
  it("preserves queued and uncertain authorized jobs, held credits and supplier ceilings when stopping", async () => {
    for (const status of ["QUEUED", "NEEDS_RECONCILIATION"]) {
      const c = await draftCycle(); await runOneWeeklyDraft();
      await db.job.updateMany({ where: { businessId: c.scope.businessId }, data: { status } });
      const jobs = await db.job.findMany({ where: { businessId: c.scope.businessId } });
      const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: c.scope.organizationId } });
      const authorizations = await db.supplierAuthorization.findMany({ where: { key: { in: jobs.flatMap(j => j.quoteId ? [j.quoteId] : []) } } });
      await cancelWeeklyCycle(c.scope, c.cancel);
      expect(await db.job.findMany({ where: { businessId: c.scope.businessId } })).toEqual(jobs);
      expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: c.scope.organizationId } })).toEqual(wallet);
      expect(await db.supplierAuthorization.findMany({ where: { key: { in: authorizations.map(a => a.key) } } })).toEqual(authorizations);
      const read = (await readPlanning(c.scope)).cycles[0]; expect(read.creditsAuthorized).toBe(1); expect(read.tasks.find(t => t.status === "AUTHORIZED")).toMatchObject({ jobStatus: status, heldCredits: 1 });
      expect(read.canCancel).toBe(false);
    }
  });
  it("denies cross-tenant, non-admin, stale-version and completed-run cancellation", async () => {
    const c = await draftCycle(), other = await setup();
    await expect(cancelWeeklyCycle(c.editor, c.cancel)).rejects.toThrow("administrators");
    await expect(cancelWeeklyCycle(other.scope, c.cancel)).rejects.toThrow("not found");
    await expect(cancelWeeklyCycle(c.scope, { ...c.cancel, policyVersion: 99 })).rejects.toThrow("changed");
    await db.weeklyCycle.update({ where: { id: c.cycle.id }, data: { status: "COMPLETE" } });
    await expect(cancelWeeklyCycle(c.scope, c.cancel)).rejects.toThrow("finished");
  });
  it("revokes quotes for blocked runs when the recurring policy is changed", async () => {
    const c = await draftCycle();
    await db.weeklyCycle.update({ where: { id: c.cycle.id }, data: { status: "BLOCKED" } });
    await db.weeklyTask.update({ where: { id: c.cycle.tasks[0].id }, data: { status: "STOPPED" } });
    await savePlanning(c.scope, { ...policy, enabled: false, version: 1 });
    const row = await db.weeklyCycle.findUniqueOrThrow({ where: { id: c.cycle.id }, include: { tasks: true } });
    expect(row.status).toBe("CANCELLED"); expect(row.tasks.every(t => t.status === "CANCELLED")).toBe(true);
  });
  it("cancellation during quote construction cannot resurrect tasks or authorize a late quote", async () => {
    const c = await draftCycle(); let quoteId = "";
    await runOneWeeklyDraft(async (...args) => {
      const result = await actOnProduction(...args);
      if ("quote" in result && result.quote) { quoteId = result.quote.id; await cancelWeeklyCycle(c.scope, c.cancel); }
      return result;
    });
    const cycle = await db.weeklyCycle.findUniqueOrThrow({ where: { id: c.cycle.id }, include: { tasks: true } });
    expect(cycle.status).toBe("CANCELLED"); expect(cycle.tasks.every(t => t.status === "CANCELLED")).toBe(true);
    expect((await db.generationQuote.findUniqueOrThrow({ where: { id: quoteId } })).status).toBe("CANCELLED");
    expect(await db.job.count({ where: { businessId: c.scope.businessId } })).toBe(0);
  });
  it("an expired worker cannot accept a quote, mark tasks stopped or clear the replacement lease", async () => {
    const c = await draftCycle(), replacement = new Date(Date.now() + 600000);
    await runOneWeeklyDraft(async (...args) => {
      const action = args[1] as { action: string };
      if (action.action === "accept") await db.weeklyCycle.update({ where: { id: c.cycle.id }, data: { leaseUntil: replacement } });
      return actOnProduction(...args);
    });
    const row = await db.weeklyCycle.findUniqueOrThrow({ where: { id: c.cycle.id }, include: { tasks: true } });
    expect(row).toMatchObject({ status: "OPEN", leaseUntil: replacement, creditsAuthorized: 0 });
    expect(row.tasks.some(t => t.status === "QUOTED")).toBe(true); expect(await db.job.count({ where: { businessId: c.scope.businessId } })).toBe(0);
    expect((await db.wallet.findUniqueOrThrow({ where: { organizationId: c.scope.organizationId } })).held).toBe(0);
  });
  it("an expired quote-building worker cannot attach a quote to a newly leased run", async () => {
    const c = await draftCycle(), replacement = new Date(Date.now() + 600000);
    await runOneWeeklyDraft(async (...args) => {
      const result = await actOnProduction(...args);
      await db.weeklyCycle.update({ where: { id: c.cycle.id }, data: { leaseUntil: replacement } }); return result;
    });
    const row = await db.weeklyCycle.findUniqueOrThrow({ where: { id: c.cycle.id }, include: { tasks: true } });
    expect(row).toMatchObject({ status: "OPEN", leaseUntil: replacement }); expect(row.tasks.every(t => t.status === "PENDING" && !t.quoteId)).toBe(true);
    expect((await db.generationQuote.findFirstOrThrow({ where: { businessId: c.scope.businessId } })).status).toBe("CANCELLED");
  });
  it("cancellation immediately before acceptance rolls back all spend authorization", async () => {
    const c = await draftCycle();
    await runOneWeeklyDraft(async (...args) => {
      if ((args[1] as { action: string }).action === "accept") await cancelWeeklyCycle(c.scope, c.cancel);
      return actOnProduction(...args);
    });
    expect((await db.weeklyCycle.findUniqueOrThrow({ where: { id: c.cycle.id } })).status).toBe("CANCELLED");
    expect(await db.job.count({ where: { businessId: c.scope.businessId } })).toBe(0);
    const quote = await db.generationQuote.findFirstOrThrow({ where: { businessId: c.scope.businessId } });
    expect(await db.supplierAuthorization.count({ where: { key: quote.id } })).toBe(0);
    expect((await db.wallet.findUniqueOrThrow({ where: { organizationId: c.scope.organizationId } })).held).toBe(0);
  });
  it("a restarted worker can recover an expired pre-acceptance lease exactly once", async () => {
    const c = await draftCycle();
    await runOneWeeklyDraft(async (...args) => {
      if ((args[1] as { action: string }).action === "accept") await db.weeklyCycle.update({ where: { id: c.cycle.id }, data: { leaseUntil: new Date(Date.now() - 1) } });
      return actOnProduction(...args);
    });
    expect(await db.job.count({ where: { businessId: c.scope.businessId } })).toBe(0);
    await Promise.all([runOneWeeklyDraft(), runOneWeeklyDraft()]);
    expect(await db.job.count({ where: { businessId: c.scope.businessId } })).toBe(1);
    expect((await db.weeklyCycle.findUniqueOrThrow({ where: { id: c.cycle.id } })).creditsAuthorized).toBe(1);
    expect((await db.wallet.findUniqueOrThrow({ where: { organizationId: c.scope.organizationId } })).held).toBe(1);
  });
  it("planning reads enforce membership and return only safe task progress", async () => {
    const c = await draftCycle(), other = await setup(); await runOneWeeklyDraft();
    const jobs = await db.job.findMany({ where: { businessId: c.scope.businessId } });
    await db.job.update({ where: { id: jobs[0].id }, data: { errorCode: "private-error", payload: { secret: "private-prompt" }, providerTaskId: "private-receipt" } });
    const result = await readPlanning(c.editor); expect(result.canManage).toBe(false); expect(result.cycles[0].canCancel).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/private-|actorId|quoteId|reservationId|errorCode|payload|configurationHash/);
    await expect(readPlanning({ ...c.scope, actorId: other.scope.actorId })).rejects.toThrow("not found");
    await expect(readPlanning({ ...c.scope, businessId: other.scope.businessId })).rejects.toThrow("not found");
  });
});
