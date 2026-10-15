import { afterAll, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { readPlanHistory } from "../src/lib/production/history";
import { actOnProduction } from "../src/lib/production/service";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local fixture DB required");
suite("scoped and bounded plan history", () => {
  const orgs: string[] = [], users: string[] = [];
  const copy = { headline: "Considered spaces", caption: "Architecture consultations for your home.", cta: "Meet us", visualDirection: "Original brand imagery", rationale: "Fixture only", evidenceUsed: [] };
  afterAll(async () => { await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.user.deleteMany({ where: { id: { in: users } } }); await db.$disconnect(); });
  async function setup(count = 1) {
    const user = await db.user.create({ data: { name: "History fixture", email: `history-${crypto.randomUUID()}@example.test`, passwordHash: "no-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "History fixture", wallet: { create: {} }, memberships: { create: { userId: user.id, role: "OWNER" } } } }); orgs.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "History studio", offering: "Architecture consultations", confirmedAt: new Date() } });
    const scope = { organizationId: org.id, businessId: business.id, actorId: user.id };
    const plans = [];
    for (let i = 0; i < count; i++) plans.push(await db.productionPlan.create({ data: { organizationId: org.id, businessId: business.id, title: `Week ${i}`, brandVersion: 1, creditCeiling: 0, createdAt: new Date("2026-01-01T00:00:00Z"), items: { create: { title: `Creative ${i}`, channel: "Instagram", format: "static", brief: { privateHarness: "NOT_FOR_HISTORY" }, revisions: { create: { version: 1, status: "READY", content: copy, authorId: user.id } } } } }, include: { items: { include: { revisions: true } } } }));
    return { scope, plans };
  }
  it("paginates ten at a time with stable tie-breaking and no duplicates after a new insertion", async () => {
    const f = await setup(23), first = await readPlanHistory(f.scope);
    if (!first.plans) throw Error("Expected list"); expect(first.plans).toHaveLength(10);
    await db.productionPlan.create({ data: { organizationId: f.scope.organizationId, businessId: f.scope.businessId, title: "New arrival", brandVersion: 1, creditCeiling: 0 } });
    const second = await readPlanHistory(f.scope, { before: first.nextCursor }); if (!second.plans) throw Error("Expected list");
    const third = await readPlanHistory(f.scope, { before: second.nextCursor }); if (!third.plans) throw Error("Expected list");
    expect(second.plans).toHaveLength(10); expect(third.plans).toHaveLength(3); expect(third.nextCursor).toBeNull();
    expect(new Set([...first.plans, ...second.plans, ...third.plans].map(p => p.id)).size).toBe(23);
    expect(first.plans.map(p => p.id)).toEqual([...first.plans.map(p => p.id)].sort().reverse());
    expect(first.plans[0]._count.items).toBe(1); expect(JSON.stringify(first)).not.toContain("privateHarness");
  });
  it("isolates plan IDs and history anchors across businesses and tenants", async () => {
    const a = await setup(), b = await setup();
    await expect(readPlanHistory(b.scope, { plan: a.plans[0].id })).rejects.toThrow("Plan not found");
    await expect(readPlanHistory(b.scope, { before: a.plans[0].id })).rejects.toThrow("History position");
    await expect(readPlanHistory({ ...a.scope, actorId: b.scope.actorId })).rejects.toThrow("Business not found");
    const sameOrg = await db.business.create({ data: { organizationId: a.scope.organizationId, name: "Other brand", offering: "Different offering" } });
    await expect(readPlanHistory({ ...a.scope, businessId: sameOrg.id }, { plan: a.plans[0].id })).rejects.toThrow("Plan not found");
  });
  it("reads only the latest copy and safe quote fields without revealing prompts or provenance", async () => {
    const f = await setup(), plan = f.plans[0], item = plan.items[0];
    await db.creativeRevision.create({ data: { organizationId: f.scope.organizationId, itemId: item.id, version: 2, status: "READY", content: { ...copy, headline: "Latest saved copy" }, provenance: { hidden: "NOT_FOR_HISTORY" } } });
    await db.generationQuote.create({ data: { organizationId: f.scope.organizationId, businessId: f.scope.businessId, itemId: item.id, brandVersion: 1, baseVersion: 1, mode: "initial", credits: 1, supplierCeilingMicros: 1, request: { privatePrompt: "NOT_FOR_HISTORY" }, configurationHash: "hidden", expiresAt: new Date() } });
    const result = await readPlanHistory(f.scope, { plan: plan.id }); if (!result.plan) throw Error("Expected detail");
    expect(result.canEdit).toBe(true); expect(result.plan.items[0].revisions).toHaveLength(1); expect(result.plan.items[0].revisions[0].version).toBe(2);
    expect(result.plan.items[0].quotes[0].credits).toBe(1); expect(JSON.stringify(result)).not.toContain("NOT_FOR_HISTORY");
  });
  it("keeps stale plans inspectable and rejects their mutation without jobs or credit holds", async () => {
    const f = await setup(), plan = f.plans[0]; await db.productionPlan.update({ where: { id: plan.id }, data: { status: "SUPERSEDED" } });
    const result = await readPlanHistory(f.scope, { plan: plan.id }); if (!("plan" in result)) throw Error("Expected detail"); expect(result.canEdit).toBe(false);
    await expect(actOnProduction(f.scope, { action: "edit", itemId: plan.items[0].id, version: 1, headline: "Changed", caption: copy.caption, cta: copy.cta })).rejects.toThrow("brand changed");
    expect(await db.job.count({ where: { organizationId: f.scope.organizationId } })).toBe(0); expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
  });
  it("withholds edit permission for viewers, unconfirmed brands and older brand versions", async () => {
    const f = await setup(), request = { plan: f.plans[0].id };
    await db.membership.update({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } }, data: { role: "VIEWER" } });
    expect(await readPlanHistory(f.scope, request)).toMatchObject({ canEdit: false });
    await db.membership.update({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } }, data: { role: "OWNER" } });
    await db.business.update({ where: { id: f.scope.businessId }, data: { confirmedAt: null } }); expect(await readPlanHistory(f.scope, request)).toMatchObject({ canEdit: false });
    await db.business.update({ where: { id: f.scope.businessId }, data: { confirmedAt: new Date(), version: 2 } }); expect(await readPlanHistory(f.scope, request)).toMatchObject({ canEdit: false });
    await db.membership.delete({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } } }); await expect(readPlanHistory(f.scope, request)).rejects.toThrow("Business not found");
  });
  it("rejects malformed or conflicting queries rather than performing broad reads", async () => {
    const f = await setup();
    for (const raw of [{ before: "" }, { before: "a".repeat(101) }, { before: "cursor", plan: "id" }, { take: 100000 }, { plan: "missing" }, { before: "deleted" }]) await expect(readPlanHistory(f.scope, raw)).rejects.toThrow();
  });
});
