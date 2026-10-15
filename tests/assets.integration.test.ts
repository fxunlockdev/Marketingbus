import { afterAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { db } from "../src/lib/db";
import { uploadAsset, readAsset, changeAsset, purgeExpiredAssets } from "../src/lib/assets/service";
import { BUSINESS_ASSET_BYTES } from "../src/lib/assets/images";
import type { AssetStore } from "../src/lib/assets/storage";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Asset tests require an explicitly local database.");
suite("private asset ownership and quota", () => {
  const organizations: string[] = [];
  const store: AssetStore = { put: vi.fn(async () => {}), get: vi.fn(async () => new Uint8Array([1, 2, 3])), remove: vi.fn(async () => {}) };
  afterAll(async () => {
    await db.brandAsset.deleteMany({ where: { organizationId: { in: organizations } } });
    await db.organization.deleteMany({ where: { id: { in: organizations } } }); await db.$disconnect();
  });
  async function setup() {
    const org = await db.organization.create({ data: { name: "ASSET TEST ONLY" } }); organizations.push(org.id);
    const biz = await db.business.create({ data: { name: "Asset fixture", organizationId: org.id } });
    return { organizationId: org.id, businessId: biz.id, actorId: "test-user" };
  }
  const input = { label: "Fixture logo", purpose: "logo", rightsConfirmed: true };
  const image = () => sharp({ create: { width: 20, height: 20, channels: 3, background: "#c67139" } }).png().toBuffer();
  it("stores private metadata, deduplicates within a business, and rejects another tenant", async () => {
    const a = await setup(), b = await setup(); const bytes = await image();
    const uploaded = await uploadAsset(a, input, bytes, store);
    expect(uploaded.asset).not.toHaveProperty("objectKey");
    expect(uploaded.asset.status).toBe("READY");
    expect((await uploadAsset(a, input, bytes, store)).deduplicated).toBe(true);
    // Never spread actorId into the ownership query.
    expect(await readAsset({ businessId: a.businessId, organizationId: a.organizationId }, uploaded.asset.id, store)).toEqual(new Uint8Array([1, 2, 3]));
    await expect(readAsset({ businessId: b.businessId, organizationId: b.organizationId }, uploaded.asset.id, store)).rejects.toThrow("not found");
    const other = await uploadAsset(b, input, bytes, store); expect(other.asset.id).not.toBe(uploaded.asset.id);
  });
  it("requires rights confirmation before storing", async () => {
    const scope = await setup(); await expect(uploadAsset(scope, { ...input, rightsConfirmed: false }, await image(), store)).rejects.toThrow();
    expect(await db.brandAsset.count({ where: { businessId: scope.businessId } })).toBe(0);
  });
  it("archives privately, restores without reapproval and purges only after retention", async () => {
    const scope = await setup(); const other = await setup(); const uploaded = await uploadAsset(scope, input, await image(), store);
    const id = uploaded.asset.id; const now = new Date();
    await expect(changeAsset(other, id, { action: "archive" })).rejects.toThrow("not found");
    await changeAsset(scope, id, { action: "approve", approved: true });
    await changeAsset(scope, id, { action: "archive" }, now);
    await expect(readAsset(scope, id, store)).rejects.toThrow("not found");
    expect(await purgeExpiredAssets(store, now)).toBe(0);
    await changeAsset(scope, id, { action: "restore" }, now);
    expect(await db.brandAsset.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "READY", approvedForGeneration: false });
    await changeAsset(scope, id, { action: "archive" }, now);
    const after = new Date(now.getTime() + 8 * 86400000);
    expect(await purgeExpiredAssets(store, after)).toBe(1);
    expect(await db.brandAsset.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "DELETED", bytes: 0 });
    await expect(changeAsset(scope, id, { action: "restore" }, after)).rejects.toThrow("not found");
  });
  it("uncertain deletes remain inaccessible and retry after lease expiry", async () => {
    const scope = await setup(); const uploaded = await uploadAsset(scope, input, await image(), store); const now = new Date();
    await changeAsset(scope, uploaded.asset.id, { action: "archive" }, now);
    const after = new Date(now.getTime() + 8 * 86400000);
    await purgeExpiredAssets({ ...store, remove: async () => { throw Error("network failure"); } }, after);
    expect((await db.brandAsset.findUniqueOrThrow({ where: { id: uploaded.asset.id } })).status).toBe("DELETING");
    await expect(changeAsset(scope, uploaded.asset.id, { action: "restore" }, after)).rejects.toThrow("deletion has begun");
    expect(await purgeExpiredAssets(store, new Date(after.getTime() + 121000))).toBe(1);
  });
  it("retains uncertain uploads against quota and never serves them", async () => {
    const scope = await setup(); const failing = { ...store, put: async () => { throw Error("timeout after send"); } };
    await expect(uploadAsset(scope, input, await image(), failing)).rejects.toThrow("could not be confirmed");
    const row = await db.brandAsset.findFirstOrThrow({ where: { businessId: scope.businessId } });
    expect(row.status).toBe("FAILED"); expect(row.bytes).toBeGreaterThan(0);
    await expect(readAsset({ businessId: scope.businessId, organizationId: scope.organizationId }, row.id, store)).rejects.toThrow("not found");
  });
  it("serializes quota checks and includes pending/failed reservations", async () => {
    const scope = await setup();
    for (let i = 0; i < 5; i++) await db.brandAsset.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId, objectKey: `fixture-${crypto.randomUUID()}`, label: "quota fixture", purpose: "product", sha256: "fixture", bytes: BUSINESS_ASSET_BYTES / 5, width: 1, height: 1, uploadedBy: scope.actorId, rightsConfirmedAt: new Date(), status: "PENDING" } });
    await expect(uploadAsset(scope, input, await image(), store)).rejects.toThrow("allowance");
  });
});
