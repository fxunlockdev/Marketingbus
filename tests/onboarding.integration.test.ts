import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { startSetup, startConnectionDraft, readSetup, manageSetup } from "../src/lib/onboarding/service";
import { brandInput, draftBrandInput, proposePlan } from "../src/lib/brand";
import { contentPreferences } from "../src/lib/onboarding/preferences";
import { compileHarness } from "../src/lib/harness/contracts";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL || !["127.0.0.1", "localhost"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local test database required");
suite("durable guided setup", () => {
  const organizations: string[] = [], users: string[] = [];
  afterAll(async () => { await db.organization.deleteMany({ where: { id: { in: organizations } } }); await db.user.deleteMany({ where: { id: { in: users } } }); await db.$disconnect(); });
  async function fixture(role = "OWNER") {
    const user = await db.user.create({ data: { name: "SETUP FIXTURE", email: `setup-${randomUUID()}@example.test`, passwordHash: "not-a-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "SETUP FIXTURE", memberships: { create: { userId: user.id, role } }, wallet: { create: { available: 0 } } } }); organizations.push(org.id);
    const input = { organizationId: org.id, requestId: randomUUID(), name: "Fixture Studio", website: "https://example.test", industry: "Design" };
    return { user, org, input };
  }
  async function started() {
    const f = await fixture(); const { id } = await startSetup(f.user.id, f.input);
    return { ...f, scope: { businessId: id, organizationId: f.org.id, actorId: f.user.id } };
  }
  it("creates an idempotent connection-only draft, but requires a website before advancing setup", async () => {
    const f = await fixture(), input = { organizationId: f.org.id, name: f.input.name, requestId: f.input.requestId };
    const [a, b] = await Promise.all([startConnectionDraft(f.user.id, input), startConnectionDraft(f.user.id, input)]);
    expect(a.id).toBe(b.id);
    const scope = { businessId: a.id, organizationId: f.org.id, actorId: f.user.id }, state = await readSetup(scope);
    expect(state.profile.website).toBe("");
    expect(await db.business.findUnique({ where: { id: a.id } })).toMatchObject({ confirmedAt: null, productionEnabled: false });
    await expect(manageSetup(scope, { action: "save", revision: state.revision, version: state.version, step: 2, profile: state.profile })).rejects.toThrow("business website");
    await manageSetup(scope, { action: "save", revision: state.revision, version: state.version, step: 1, profile: { ...state.profile, website: "https://example.test" } });
    expect((await readSetup(scope)).profile.website).toBe("https://example.test");
    expect(await db.socialPublication.count({ where: { businessId: a.id } })).toBe(0);
  });
  it.each(["", "http://example.com", "https://127.0.0.1", "https://service.railway.internal", "https://user:password@example.com"])("rejects an unsuitable required website: %s", async website => {
    const f = await fixture(); await expect(startSetup(f.user.id, { ...f.input, website })).rejects.toThrow();
    expect(await db.business.count({ where: { organizationId: f.org.id } })).toBe(0);
  });
  it("does not let a viewer create a connection draft", async () => {
    const f = await fixture("VIEWER");
    await expect(startConnectionDraft(f.user.id, { organizationId: f.org.id, requestId: randomUUID(), name: "Another business" })).rejects.toThrow("owner or admin");
  });
  async function save(f: Awaited<ReturnType<typeof started>>, step: number, patch: Record<string, unknown> = {}) {
    const state = await readSetup(f.scope);
    await manageSetup(f.scope, { action: "save", revision: state.revision, version: state.version, step, profile: { ...state.profile, ...patch } });
    return readSetup(f.scope);
  }
  const details = { offering: "Architecture consultations", audience: "Homeowners", goal: "Book consultations" };
  async function ready() {
    const f = await started(); await save(f, 2); await save(f, 3, details); await save(f, 4); const state = await save(f, 5); return { ...f, state };
  }
  it("accepts www websites and completes the simple flow without paid work or social connections", async () => {
    const f = await fixture(), { id } = await startSetup(f.user.id, { ...f.input, website: " www.example.test " });
    const scope = { businessId: id, organizationId: f.org.id, actorId: f.user.id };
    let state = await readSetup(scope);
    expect(state.profile.website).toBe("https://www.example.test/");
    const details = { brandBook: "create", socialProfiles: [{ platform: "Instagram", url: "@studio" }] };
    await manageSetup(scope, { action: "simple-save", revision: state.revision, version: state.version, step: 2, profile: state.profile, details });
    state = await readSetup(scope);
    expect(state.details).toMatchObject({ brandBook: "create", socialProfiles: [{ platform: "Instagram", url: "https://www.instagram.com/studio" }] });
    await manageSetup(scope, { action: "simple-save", revision: state.revision, version: state.version, step: 5, profile: { ...state.profile, offering: "Design consultations", audience: "Homeowners", goal: "Get enquiries" }, details: state.details });
    state = await readSetup(scope);
    await manageSetup(scope, { action: "finish", revision: state.revision, version: state.version, confirmed: true });
    expect((await readSetup(scope)).step).toBe(6);
    expect(await db.socialConnection.count({ where: { businessId: id } })).toBe(0);
    expect(await db.reservation.count({ where: { organizationId: f.org.id } })).toBe(0);
    expect(await db.productionPlan.count({ where: { businessId: id } })).toBe(1);
  });
  it("rejects stale or unauthorized simple saves and untrusted profile destinations", async () => {
    const f = await started(), state = await readSetup(f.scope);
    const input = { action: "simple-save", revision: state.revision, version: state.version, step: 2, profile: state.profile, details: { brandBook: "skip", socialProfiles: [] } };
    await expect(manageSetup(f.scope, { ...input, details: { brandBook: "skip", socialProfiles: [{ platform: "Instagram", url: "https://evil.test/brand" }] } })).rejects.toThrow("profile links");
    await expect(manageSetup(f.scope, { ...input, details: { brandBook: "undecided" } })).rejects.toThrow("brand book");
    await manageSetup(f.scope, input);
    await expect(manageSetup(f.scope, input)).rejects.toThrow("another tab");
    const current = await readSetup(f.scope);
    await db.membership.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.user.id } }, data: { role: "VIEWER" } });
    await expect(manageSetup(f.scope, { ...input, revision: current.revision })).rejects.toThrow("editing access");
  });
  it("creates once under concurrent retries without spending, crawling or confirming", async () => {
    const f = await fixture(); const [a, b] = await Promise.all([startSetup(f.user.id, f.input), startSetup(f.user.id, f.input)]);
    expect(a.id).toBe(b.id); expect(await db.business.count({ where: { organizationId: f.org.id } })).toBe(1);
    const business = await db.business.findUniqueOrThrow({ where: { id: a.id } });
    expect(business).toMatchObject({ setupStep: 1, setupRevision: 1, confirmedAt: null, offering: "", productionEnabled: false });
    expect(await db.job.count({ where: { businessId: a.id } })).toBe(0);
    expect(await db.reservation.count({ where: { organizationId: f.org.id } })).toBe(0);
    expect(await db.knowledgeSource.count({ where: { businessId: a.id } })).toBe(0);
  });
  it.each(["EDITOR", "VIEWER"])("does not let a %s create businesses", async role => { const f = await fixture(role); await expect(startSetup(f.user.id, f.input)).rejects.toThrow("owner or admin"); });
  it("does not reuse a request token across tenants", async () => {
    const a = await fixture(), b = await fixture(); b.input.requestId = a.input.requestId;
    const x = await startSetup(a.user.id, a.input), y = await startSetup(b.user.id, b.input);
    expect(x.id).not.toBe(y.id); await expect(startSetup(b.user.id, { ...a.input, requestId: randomUUID() })).rejects.toThrow("owner or admin");
  });
  it("retains the existing organization business allowance", async () => {
    const f = await fixture(); for (let i = 0; i < 3; i++) await startSetup(f.user.id, { ...f.input, requestId: randomUUID() });
    await expect(startSetup(f.user.id, { ...f.input, requestId: randomUUID() })).rejects.toThrow("three businesses");
  });
  it("enforces valid nullable setup state in PostgreSQL", async () => {
    const f = await started();
    await expect(db.business.update({ where: { id: f.scope.businessId }, data: { setupStep: null } })).rejects.toThrow();
    await expect(db.business.update({ where: { id: f.scope.businessId }, data: { setupStep: 7 } })).rejects.toThrow();
    await expect(db.business.update({ where: { id: f.scope.businessId }, data: { setupRevision: 0 } })).rejects.toThrow();
  });
  it("resumes saved fields and preserves the brand version for unchanged steps", async () => {
    const f = await started(); const unchanged = await save(f, 2); expect(unchanged.version).toBe(1);
    const changed = await save(f, 3, details); expect(changed.version).toBe(2); expect(changed.profile).toMatchObject(details);
    expect((await readSetup(f.scope)).step).toBe(3);
  });
  it("rejects stale tabs and concurrent saves rather than overwriting", async () => {
    const f = await started(), state = await readSetup(f.scope);
    const input = { action: "save", revision: state.revision, version: state.version, step: 2, profile: state.profile };
    const results = await Promise.allSettled([manageSetup(f.scope, input), manageSetup(f.scope, input)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });
  it("rejects profile changes made outside setup until reloaded", async () => {
    const f = await started(), state = await readSetup(f.scope);
    await db.business.update({ where: { id: f.scope.businessId }, data: { version: { increment: 1 } } });
    await expect(manageSetup(f.scope, { action: "save", revision: state.revision, version: state.version, step: 2, profile: state.profile })).rejects.toThrow("another tab");
  });
  it("rejects cross-tenant reads and writes", async () => {
    const a = await started(), b = await started();
    await expect(readSetup({ ...a.scope, actorId: b.user.id })).rejects.toThrow("not found");
    await expect(readSetup({ ...a.scope, organizationId: b.org.id })).rejects.toThrow("not found");
    await expect(manageSetup({ ...a.scope, actorId: b.user.id }, { action: "finish", revision: 1, version: 1, confirmed: true })).rejects.toThrow("editing access");
  });
  it("rechecks revoked editor access under lock", async () => {
    const f = await started(); await db.membership.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.user.id } }, data: { role: "VIEWER" } });
    expect((await readSetup(f.scope)).canEdit).toBe(false);
    await expect(save(f, 2)).rejects.toThrow("editing access");
  });
  it("does not skip mandatory steps or confirm empty profiles", async () => {
    const f = await started(); await expect(save(f, 5)).rejects.toThrow("preceding");
    await save(f, 2); await expect(save(f, 3)).rejects.toThrow();
    const s = await readSetup(f.scope);
    await expect(manageSetup(f.scope, { action: "finish", revision: s.revision, version: s.version, confirmed: true })).rejects.toThrow("Review your setup");
    expect((await db.business.findUniqueOrThrow({ where: { id: f.scope.businessId } })).confirmedAt).toBeNull();
  });
  it("requires explicit confirmation and creates one current outline atomically", async () => {
    const f = await ready(); const input = { action: "finish", revision: f.state.revision, version: f.state.version, confirmed: true };
    await expect(manageSetup(f.scope, { ...input, confirmed: false })).rejects.toThrow();
    await Promise.all([manageSetup(f.scope, input), manageSetup(f.scope, input)]);
    const business = await db.business.findUniqueOrThrow({ where: { id: f.scope.businessId } });
    expect(business.setupStep).toBe(6); expect(business.confirmedAt).not.toBeNull(); expect(business.productionEnabled).toBe(false);
    expect(await db.productionPlan.count({ where: { businessId: business.id } })).toBe(1);
    expect(await db.brandSnapshot.count({ where: { businessId: business.id } })).toBe(1);
    expect(await db.socialPublication.count({ where: { businessId: business.id } })).toBe(0);
    expect(await db.reservation.count({ where: { organizationId: f.org.id } })).toBe(0);
    await expect(save(f, 4)).rejects.toThrow("complete");
  });
  it("stores strategy and language in the brand, outline and specialist context", async () => {
    const f = await started(); await save(f, 2); const state = await save(f, 3, { ...details, contentPreferences: { businessType: "local", strategy: "product", language: "English (UK)", visualStyle: "studio" } });
    const brand = brandInput.parse(state.profile);
    expect(proposePlan(brand)[0].brief.contentPreferences).toMatchObject({ strategy: "product", language: "English (UK)" });
    const harness = await compileHarness({ organizationId: f.org.id, businessId: f.scope.businessId, planItemId: "fixture", brandVersion: state.version, discipline: "static", objective: brand.goal, audienceTension: "Homeowners need considered spaces", proposition: brand.offering, evidence: [], concept: "Show a design consultation", direction: "Explain the service accurately", brand, brandConfirmed: true, creditCeiling: 100, preferences: [] }, f.scope);
    expect(JSON.parse(harness.input).brand.contentPreferences).toEqual(brand.contentPreferences);
  });
});
describe("setup input contracts", () => {
  it("allows incomplete drafts but requires meaningful facts for confirmation", () => {
    const draft = draftBrandInput.parse({ name: "Example", offering: "", audience: "", goal: "" });
    expect(brandInput.safeParse(draft).success).toBe(false);
  });
  it("rejects unknown preference fields and unsupported choices", () => {
    expect(() => contentPreferences.parse({ autoPublish: true })).toThrow();
    expect(() => contentPreferences.parse({ language: "invented" })).toThrow();
  });
});
