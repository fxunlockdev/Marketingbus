import { afterAll, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { readCalendar, calendarPageSize } from "../src/lib/production/calendar";
import { actOnProduction, type Scope } from "../src/lib/production/service";
const local = process.env.TEST_DATABASE_URL;
if (local && (process.env.DATABASE_URL !== local || !["localhost", "127.0.0.1"].includes(new URL(local).hostname))) throw Error("Local test DB required");
const suite = local ? describe : describe.skip;
suite("cross-plan calendar, scope and optimistic reservation edits", () => {
  const orgs: string[] = [], users: string[] = [];
  const instant = new Date(Date.now() + 3 * 86400000);
  const query = { start: new Date(instant.getTime() - 86400000).toISOString(), end: new Date(instant.getTime() + 86400000).toISOString() };
  const content = { headline: "Considered homes", caption: "Architecture consultations for homeowners.", cta: "Meet us", visualDirection: "Original brand imagery", rationale: "Fixture only", evidenceUsed: [] };
  afterAll(async () => {
    await db.socialPublication.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.user.deleteMany({ where: { id: { in: users } } }); await db.$disconnect();
  });
  async function fixture() {
    const user = await db.user.create({ data: { name: "Calendar fixture", email: `${crypto.randomUUID()}@example.test`, passwordHash: "not-a-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "CALENDAR FIXTURE", memberships: { create: { userId: user.id, role: "OWNER" } }, wallet: { create: { available: 70, held: 30 } } } }); orgs.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Architecture", confirmedAt: new Date() } });
    const scope: Scope = { businessId: business.id, organizationId: org.id, actorId: user.id };
    async function plan(title: string, count = 1, when = instant) {
      const row = await db.productionPlan.create({ data: { businessId: business.id, organizationId: org.id, title, brandVersion: 1, creditCeiling: 0,
        items: { create: Array.from({ length: count }, (_, i) => ({ title: `${title} item ${i}`, format: "static", channel: "Instagram", brief: { hidden: "PRIVATE-BRIEF" }, revisions: { create: { version: 1, status: "APPROVED", content, provenance: { hidden: "PRIVATE-PROVENANCE" } } } })) },
      }, include: { items: { include: { revisions: true } } } });
      await db.calendarEntry.createMany({ data: row.items.map(item => ({ organizationId: org.id, itemId: item.id, revisionId: item.revisions[0].id, scheduledFor: when, timezone: "UTC" })) });
      return row;
    }
    return { scope, plan };
  }
  async function move(scope: Scope, entry: Awaited<ReturnType<typeof readCalendar>>["entries"][number], delta = 3600000) {
    return actOnProduction(scope, { action: "schedule", itemId: entry.itemId, version: entry.revisionVersion, expectedCalendar: { id: entry.id, version: entry.version }, scheduledFor: new Date(new Date(entry.scheduledFor).getTime() + delta).toISOString(), timezone: "UTC" });
  }
  it("returns all plans for one business with exact-version eligibility and no private content", async () => {
    const f = await fixture(); await f.plan("Earlier"); await f.plan("Latest"); const other = await fixture(); await other.plan("Foreign");
    const result = await readCalendar(f.scope, query);
    expect(result.entries.map(e => e.planTitle).sort()).toEqual(["Earlier", "Latest"]);
    expect(result.entries.every(e => e.canMove && e.canRemove && e.revisionApproved)).toBe(true);
    for (const text of ["PRIVATE", "content", "provenance", "Foreign", "password", "encrypted"]) expect(JSON.stringify(result)).not.toContain(text);
    expect(result.nextCursor).toBeNull();
  });
  it("isolates membership, business and workspace MFA at the service boundary", async () => {
    const a = await fixture(), b = await fixture(); await a.plan("Only A");
    await expect(readCalendar({ ...a.scope, actorId: b.scope.actorId }, query)).rejects.toThrow("not found");
    await expect(readCalendar({ ...a.scope, businessId: b.scope.businessId }, query)).rejects.toThrow("not found");
    await db.organization.update({ where: { id: a.scope.organizationId }, data: { requireMfa: true } });
    await expect(readCalendar(a.scope, query)).rejects.toThrow("requires MFA");
  });
  it("uses stable bounded keyset pages and rejects missing or foreign anchors", async () => {
    const f = await fixture(); await f.plan("Many", calendarPageSize + 1);
    const first = await readCalendar(f.scope, query); expect(first.entries).toHaveLength(calendarPageSize); expect(first.nextCursor).toBeTruthy();
    const second = await readCalendar(f.scope, { ...query, after: first.nextCursor }); expect(second.entries).toHaveLength(1);
    expect(second.entries.some(e => first.entries.some(a => a.id === e.id))).toBe(false);
    const foreign = await fixture(); await foreign.plan("Other"); const foreignId = (await readCalendar(foreign.scope, query)).entries[0].id;
    await expect(readCalendar(f.scope, { ...query, after: foreignId })).rejects.toThrow("page changed");
    await db.calendarEntry.delete({ where: { id: first.nextCursor! } });
    await expect(readCalendar(f.scope, { ...query, after: first.nextCursor })).rejects.toThrow("page changed");
  });
  it("rejects broad, reversed, invalid and extra query parameters", async () => {
    const f = await fixture();
    for (const input of [{}, { ...query, end: query.start }, { ...query, start: "invalid" }, { ...query, end: new Date(instant.getTime() + 90 * 86400000).toISOString() }, { ...query, limit: 100000 }]) await expect(readCalendar(f.scope, input)).rejects.toThrow();
  });
  it("treats range start as inclusive and end as exclusive", async () => {
    const f = await fixture(); await f.plan("Start", 1, new Date(query.start)); await f.plan("End", 1, new Date(query.end));
    expect((await readCalendar(f.scope, query)).entries.map(e => e.planTitle)).toEqual(["Start"]);
  });
  it("moves one exact reservation and rejects stale moves/removals without charging", async () => {
    const f = await fixture(); await f.plan("Move"); const entry = (await readCalendar(f.scope, query)).entries[0];
    const wallet = await db.wallet.findUnique({ where: { organizationId: f.scope.organizationId } });
    await move(f.scope, entry);
    expect(await db.calendarEntry.findUnique({ where: { id: entry.id } })).toMatchObject({ version: 2, scheduledFor: new Date(instant.getTime() + 3600000) });
    await expect(move(f.scope, entry)).rejects.toThrow("reservation changed");
    await expect(actOnProduction(f.scope, { action: "unschedule", itemId: entry.itemId, expectedCalendar: { id: entry.id, version: 1 } })).rejects.toThrow("reservation changed");
    await expect(actOnProduction(f.scope, { action: "unschedule", itemId: entry.itemId })).rejects.toThrow("reservation changed");
    expect(await db.wallet.findUnique({ where: { organizationId: f.scope.organizationId } })).toEqual(wallet);
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
    expect(await db.job.count({ where: { businessId: f.scope.businessId } })).toBe(0);
  });
  it("allows only one of two concurrent changes to the same snapshot", async () => {
    const f = await fixture(); await f.plan("Race"); const entry = (await readCalendar(f.scope, query)).entries[0];
    const results = await Promise.allSettled([move(f.scope, entry, 1800000), move(f.scope, entry, 3600000)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.auditEvent.count({ where: { businessId: f.scope.businessId, action: "CALENDAR_PLANNED" } })).toBe(1);
  });
  it.each([
    ["Book for USD 100", "100 consultations delivered. USD payments accepted."],
    ["January 12, 2028", "January 12, 2027. Separate plans for 2028."],
    ["February 31", "February 31"],
    ["Friday 12 January 2028", "Friday 12 January 2028"],
  ])("blocks moving legacy approved %s without changing reservations or credits", async (caption, proof) => {
    const f = await fixture(), plan = await f.plan("Legacy approval");
    await db.business.update({ where: { id: f.scope.businessId }, data: { proof } });
    await db.creativeRevision.update({ where: { id: plan.items[0].revisions[0].id }, data: { content: { ...content, caption } } });
    const entry = (await readCalendar(f.scope, query)).entries[0];
    const before = await db.calendarEntry.findUniqueOrThrow({ where: { id: entry.id } });
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } });
    await expect(move(f.scope, entry)).rejects.toThrow("unconfirmed");
    expect(await db.calendarEntry.findUniqueOrThrow({ where: { id: entry.id } })).toEqual(before);
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } })).toEqual(wallet);
    expect(await db.auditEvent.count({ where: { businessId: f.scope.businessId, action: "CALENDAR_PLANNED" } })).toBe(0);
    // Unsafe copy must not trap the owner into retaining an internal reservation.
    await actOnProduction(f.scope, { action: "unschedule", itemId: entry.itemId, expectedCalendar: { id: entry.id, version: entry.version } });
    expect(await db.calendarEntry.count({ where: { itemId: entry.itemId } })).toBe(0);
  });
  it("denies viewers and stale approvals but permits removing an obsolete internal reservation", async () => {
    const f = await fixture(); const plan = await f.plan("Review"); const entry = (await readCalendar(f.scope, query)).entries[0];
    const memberKey = { organizationId: f.scope.organizationId, userId: f.scope.actorId };
    await db.membership.update({ where: { organizationId_userId: memberKey }, data: { role: "VIEWER" } });
    expect((await readCalendar(f.scope, query)).entries[0]).toMatchObject({ canMove: false, canRemove: false });
    await expect(move(f.scope, entry)).rejects.toThrow("Editing access");
    await db.membership.update({ where: { organizationId_userId: memberKey }, data: { role: "EDITOR" } });
    await db.productionPlan.update({ where: { id: plan.id }, data: { status: "SUPERSEDED" } });
    expect((await readCalendar(f.scope, query)).entries[0]).toMatchObject({ canMove: false, canRemove: true, revisionApproved: false });
    await expect(move(f.scope, entry)).rejects.toThrow("brand changed");
    await actOnProduction(f.scope, { action: "unschedule", itemId: entry.itemId, expectedCalendar: { id: entry.id, version: entry.version } });
    expect(await db.calendarEntry.count({ where: { itemId: entry.itemId } })).toBe(0);
  });
  it("never cancels, changes or resends a linked scheduled or uncertain social post", async () => {
    const f = await fixture(), plan = await f.plan("Social"); const entry = (await readCalendar(f.scope, query)).entries[0];
    const connection = await db.socialConnection.create({ data: { organizationId: f.scope.organizationId, businessId: f.scope.businessId, provider: "Instagram", label: "Fixture", externalAccountId: "fixture", encryptedToken: "not-a-real-token", permissions: [] } });
    const post = await db.socialPublication.create({ data: { organizationId: f.scope.organizationId, businessId: f.scope.businessId, connectionId: connection.id, revisionId: plan.items[0].revisions[0].id, brandVersion: 1, payload: {}, payloadHash: "fixture", scheduledFor: instant, timezone: "UTC" } });
    for (const status of ["SCHEDULED", "SUBMITTING", "NEEDS_RECONCILIATION", "PUBLISHED"]) {
      await db.socialPublication.update({ where: { id: post.id }, data: { status, ...(status === "PUBLISHED" ? { externalPostId: "fixture-published-id", publishedAt: new Date() } : {}) } });
      const before = await db.socialPublication.findUnique({ where: { id: post.id } });
      expect((await readCalendar(f.scope, query)).entries[0]).toMatchObject({ canMove: false, canRemove: false });
      await expect(move(f.scope, entry)).rejects.toThrow(/social post/);
      await expect(actOnProduction(f.scope, { action: "unschedule", itemId: entry.itemId, expectedCalendar: { id: entry.id, version: entry.version } })).rejects.toThrow(/social post/);
      expect(await db.socialPublication.findUnique({ where: { id: post.id } })).toEqual(before);
    }
  });
  it("rechecks review comments, current revision, dates and timezone on every move", async () => {
    const f = await fixture(), plan = await f.plan("Checks"); const entry = (await readCalendar(f.scope, query)).entries[0];
    await expect(move(f.scope, entry, -10 * 86400000)).rejects.toThrow("one minute");
    await expect(actOnProduction(f.scope, { action: "schedule", itemId: entry.itemId, version: 1, expectedCalendar: { id: entry.id, version: 1 }, scheduledFor: instant.toISOString(), timezone: "Invalid/Zone" })).rejects.toThrow("timezone");
    const comment = await db.reviewComment.create({ data: { businessId: f.scope.businessId, organizationId: f.scope.organizationId, revisionId: plan.items[0].revisions[0].id, actorId: f.scope.actorId, body: "Check evidence", blocking: true } });
    expect((await readCalendar(f.scope, query)).entries[0].canMove).toBe(false);
    await expect(move(f.scope, entry)).rejects.toThrow("blocking review");
    await db.reviewComment.delete({ where: { id: comment.id } });
    await db.creativeRevision.create({ data: { organizationId: f.scope.organizationId, itemId: entry.itemId, version: 2, content, status: "READY" } });
    expect((await readCalendar(f.scope, query)).entries[0]).toMatchObject({ revisionVersion: null, canMove: false });
    await expect(move(f.scope, entry)).rejects.toThrow("no longer current");
  });
});
