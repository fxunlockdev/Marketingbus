import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { actOnProduction } from "../src/lib/production/service";
import { manageApprovals, readApprovals } from "../src/lib/workflows/approvals";
import { savePlanning, createDuePlan, runOneWeeklyDraft, nextWeekly, weekKey } from "../src/lib/workflows/planning";
import { heartbeat } from "../src/lib/production/readiness";
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
    expect(await db.weeklyCycle.count({ where: { businessId: c.scope.businessId } })).toBe(0);
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
  it("handles UTC week/year boundaries without local DST ambiguity", () => {
    expect(weekKey(new Date("2027-01-01T23:00:00Z"))).toBe("2026-12-28");
    expect(nextWeekly(1, 9, new Date("2026-10-19T09:00:00Z")).toISOString()).toBe("2026-10-26T09:00:00.000Z");
  });
});
