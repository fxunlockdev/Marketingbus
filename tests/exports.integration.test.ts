import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { manageComposition } from "../src/lib/composition/service";
import { saveCompositionExport, readCompositionExport, listCompositionExports, reconcileCompositionExport, archiveCompositionExport, purgeCompositionExports } from "../src/lib/composition/exports";
import { changeAsset, uploadAsset } from "../src/lib/assets/service";
import type { AssetStore } from "../src/lib/assets/storage";
import sharp from "sharp";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["127.0.0.1", "localhost"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local test DB required");
suite("immutable approved exports", () => {
  const orgs: string[] = [], users: string[] = [], objects = new Map<string, Buffer>();
  const store: AssetStore = { put: vi.fn(async (key, bytes, mime, immutable) => { if (immutable && objects.has(key)) throw Error("Exists"); objects.set(key, Buffer.from(bytes)); }), get: async key => { if (!objects.has(key)) throw Error("Missing"); return objects.get(key)!; }, remove: async key => { objects.delete(key); } };
  afterAll(async () => { await db.compositionExport.deleteMany({ where: { organizationId: { in: orgs } } }); await db.brandAsset.deleteMany({ where: { organizationId: { in: orgs } } }); await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.user.deleteMany({ where: { id: { in: users } } }); await db.$disconnect(); });
  async function setup(withAsset = false) {
    const user = await db.user.create({ data: { email: `export-${crypto.randomUUID()}@example.test`, name: "Export fixture", passwordHash: "fixture-no-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "EXPORT FIXTURE", memberships: { create: { userId: user.id, role: "OWNER" } } } }); orgs.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Studio", confirmedAt: new Date() } });
    const scope = { organizationId: org.id, businessId: business.id, actorId: user.id };
    const plan = await db.productionPlan.create({ data: { organizationId: org.id, businessId: business.id, title: "Fixture plan", brandVersion: 1, creditCeiling: 0, items: { create: { title: "Image", channel: "Instagram", format: "static", brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: { headline: "Made for home", caption: "Considered design for your home.", cta: "Meet us", visualDirection: "Approved brand imagery", rationale: "Fixture, not generated output", evidenceUsed: [] } } } } } }, include: { items: true } });
    let assetId: string | undefined;
    if (withAsset) {
      const bytes = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#112233" } }).png().toBuffer();
      const a = await uploadAsset(scope, { label: "Original logo", purpose: "logo", rightsConfirmed: true }, bytes, store); assetId = a.asset.id; await changeAsset(scope, assetId, { action: "approve", approved: true });
    }
    const itemId = plan.items[0].id;
    const made = await manageComposition(scope, { action: "create", itemId, revisionVersion: 1 });
    await manageComposition(scope, { action: "approve", itemId, version: 1 });
    return { scope, itemId, composition: made.composition, assetId };
  }
  it("persists an exact PNG once, reuses it and verifies the manifest and stored bytes", async () => {
    const f = await setup(), before = vi.mocked(store.put).mock.calls.length;
    const outcomes = await Promise.allSettled([1, 2].map(() => saveCompositionExport(f.scope, f.composition.id, "square", store)));
    expect(outcomes.some(o => o.status === "fulfilled")).toBe(true);
    const saved = await saveCompositionExport(f.scope, f.composition.id, "square", store);
    expect(saved.reused).toBe(true); expect(vi.mocked(store.put).mock.calls.length - before).toBe(1);
    const entry = (await listCompositionExports(f.scope))[0];
    expect(entry.manifest).toMatchObject({ compositionVersion: 1, brandVersion: 1, width: 1080, height: 1080, renderer: "static-png-v1" });
    const result = await readCompositionExport(f.scope, saved.id, store);
    expect((await sharp(result.bytes).metadata()).format).toBe("png"); expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(vi.mocked(store.put).mock.calls.at(-1)?.slice(2)).toEqual(["image/png", true]);
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
  });
  it("denies cross-tenant reading and editing, and checks current role", async () => {
    const a = await setup(), b = await setup(), saved = await saveCompositionExport(a.scope, a.composition.id, "portrait", store);
    await expect(readCompositionExport(b.scope, saved.id, store)).rejects.toThrow("unavailable");
    await expect(saveCompositionExport(b.scope, a.composition.id, "square", store)).rejects.toThrow("not found");
    await db.membership.update({ where: { organizationId_userId: { organizationId: a.scope.organizationId, userId: a.scope.actorId } }, data: { role: "VIEWER" } });
    await expect(archiveCompositionExport(a.scope, saved.id)).rejects.toThrow("editing access");
    expect((await readCompositionExport(a.scope, saved.id, store)).bytes.length).toBeGreaterThan(0);
    await db.membership.delete({ where: { organizationId_userId: { organizationId: a.scope.organizationId, userId: a.scope.actorId } } });
    await expect(readCompositionExport(a.scope, saved.id, store)).rejects.toThrow("Workspace not found");
  });
  it("revokes saved downloads after original asset permission changes", async () => {
    const f = await setup(true), saved = await saveCompositionExport(f.scope, f.composition.id, "square", store);
    await changeAsset(f.scope, f.assetId!, { action: "approve", approved: false });
    await expect(readCompositionExport(f.scope, saved.id, store)).rejects.toThrow("permission revoked");
  });
  it("revokes saved downloads after layout edits or confirmation changes", async () => {
    const f = await setup(), saved = await saveCompositionExport(f.scope, f.composition.id, "square", store);
    await manageComposition(f.scope, { action: "edit", itemId: f.itemId, version: 1, document: f.composition.document });
    await expect(readCompositionExport(f.scope, saved.id, store)).rejects.toThrow("changed");
    const other = await setup(), saved2 = await saveCompositionExport(other.scope, other.composition.id, "square", store);
    await db.business.update({ where: { id: other.scope.businessId }, data: { confirmedAt: null } });
    await expect(readCompositionExport(other.scope, saved2.id, store)).rejects.toThrow("changed");
  });
  it("rejects corrupted stored bytes", async () => {
    const f = await setup(), saved = await saveCompositionExport(f.scope, f.composition.id, "square", store);
    const row = await db.compositionExport.findUniqueOrThrow({ where: { id: saved.id } }); objects.set(row.objectKey, Buffer.from("tampered"));
    await expect(readCompositionExport(f.scope, saved.id, store)).rejects.toThrow("integrity");
  });
  it("recovers an ambiguous write using read-back only without a duplicate upload", async () => {
    const f = await setup(), put = vi.fn(async (...args: Parameters<AssetStore["put"]>) => { await store.put(...args); throw Error("Acknowledgement lost"); });
    await expect(saveCompositionExport(f.scope, f.composition.id, "square", { ...store, put })).rejects.toThrow("not verified");
    const row = (await listCompositionExports(f.scope))[0]; expect(row.status).toBe("FAILED");
    await expect(readCompositionExport(f.scope, row.id, store)).rejects.toThrow("unavailable");
    await reconcileCompositionExport(f.scope, row.id, store); expect(put).toHaveBeenCalledTimes(1);
    expect((await listCompositionExports(f.scope))[0].status).toBe("READY");
  });
  it("does not release an output if permissions change during storage", async () => {
    const f = await setup();
    const changed: AssetStore = { ...store, put: async (...args) => { await store.put(...args); await db.business.update({ where: { id: f.scope.businessId }, data: { confirmedAt: null } }); } };
    await expect(saveCompositionExport(f.scope, f.composition.id, "square", changed)).rejects.toThrow("changed");
    const row = (await listCompositionExports(f.scope))[0]; expect(row.status).toBe("FAILED");
    await expect(reconcileCompositionExport(f.scope, row.id, store)).rejects.toThrow("changed");
  });
  it("archives access immediately, retains failed-delete quota, and purges idempotently", async () => {
    const f = await setup(), saved = await saveCompositionExport(f.scope, f.composition.id, "square", store);
    await archiveCompositionExport(f.scope, saved.id); await archiveCompositionExport(f.scope, saved.id);
    await expect(readCompositionExport(f.scope, saved.id, store)).rejects.toThrow("unavailable");
    const future = new Date(Date.now() + 8 * 86400000);
    await purgeCompositionExports({ ...store, remove: async () => { throw Error("Unavailable"); } }, future);
    const row = await db.compositionExport.findUniqueOrThrow({ where: { id: saved.id } }); expect(row.status).toBe("DELETING"); expect(row.bytes).toBeGreaterThan(0);
    await purgeCompositionExports(store, new Date(future.getTime() + 120001));
    expect(await db.compositionExport.findUniqueOrThrow({ where: { id: saved.id } })).toMatchObject({ status: "DELETED", bytes: 0 });
    expect(await purgeCompositionExports(store, new Date(future.getTime() + 120002))).toBe(0);
  });
  it("rechecks permission after retrieving the file", async () => {
    const f = await setup(), saved = await saveCompositionExport(f.scope, f.composition.id, "square", store);
    await expect(readCompositionExport(f.scope, saved.id, { ...store, get: async key => { const bytes = await store.get(key); await archiveCompositionExport(f.scope, saved.id); return bytes; } })).rejects.toThrow("unavailable");
  });
  it("rejects unapproved and expired versions without new storage writes", async () => {
    const f = await setup();
    await db.staticComposition.update({ where: { id: f.composition.id }, data: { status: "DRAFT" } });
    await expect(saveCompositionExport(f.scope, f.composition.id, "square", store)).rejects.toThrow("Approve");
    expect(await db.compositionExport.count({ where: { businessId: f.scope.businessId } })).toBe(0);
    await manageComposition(f.scope, { action: "approve", itemId: f.itemId, version: 1 });
    const saved = await saveCompositionExport(f.scope, f.composition.id, "square", store);
    await db.compositionExport.update({ where: { id: saved.id }, data: { purgeAfter: new Date(0) } });
    await expect(readCompositionExport(f.scope, saved.id, store)).rejects.toThrow("unavailable");
    await expect(saveCompositionExport(f.scope, f.composition.id, "square", store)).rejects.toThrow("already exists");
  });
  it("enforces database tenant binding and reserves storage allowance before rendering", async () => {
    const a = await setup(), b = await setup();
    const data = { businessId: a.scope.businessId, organizationId: a.scope.organizationId, compositionId: a.composition.id, placement: "square", rendererVersion: "fixture-1", manifest: {}, objectKey: `fixture-${crypto.randomUUID()}`, bytes: 5242880, createdBy: a.scope.actorId, purgeAfter: new Date(Date.now() + 86400000) };
    await expect(db.compositionExport.create({ data: { ...data, businessId: b.scope.businessId, organizationId: b.scope.organizationId } })).rejects.toThrow();
    await db.compositionExport.createMany({ data: Array.from({ length: 10 }, (_, i) => ({ ...data, rendererVersion: `fixture-${i}`, objectKey: `fixture-${crypto.randomUUID()}` })) });
    await expect(saveCompositionExport(a.scope, a.composition.id, "square", store)).rejects.toThrow("allowance reached");
  });
  it("will not reconcile an active storage lease", async () => {
    const f = await setup();
    await expect(saveCompositionExport(f.scope, f.composition.id, "square", { ...store, put: async (...args) => { await store.put(...args); throw Error("Lost response"); } })).rejects.toThrow();
    const row = (await listCompositionExports(f.scope))[0];
    await db.compositionExport.update({ where: { id: row.id }, data: { status: "STORING", leaseUntil: new Date(Date.now() + 60000) } });
    await expect(reconcileCompositionExport(f.scope, row.id, store)).rejects.toThrow("still being saved");
    await db.compositionExport.update({ where: { id: row.id }, data: { leaseUntil: new Date(0) } });
    await reconcileCompositionExport(f.scope, row.id, store);
    expect((await listCompositionExports(f.scope))[0].status).toBe("READY");
  });
  it("retries a pre-storage failure using the same reservation and a fresh lease", async () => {
    const f = await setup(true);
    await expect(saveCompositionExport(f.scope, f.composition.id, "square", { ...store, get: async () => { throw Error("Source download unavailable"); } })).rejects.toThrow();
    const row = (await listCompositionExports(f.scope))[0]; expect(row.sha256).toBe("");
    const retried = await saveCompositionExport(f.scope, f.composition.id, "square", store);
    expect(retried.id).toBe(row.id); expect((await listCompositionExports(f.scope))[0].status).toBe("READY");
    expect(await db.compositionExport.count({ where: { businessId: f.scope.businessId } })).toBe(1);
  });
});
