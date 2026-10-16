import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { db } from "../src/lib/db";
import { manageImage, previewImage, listImages } from "../src/lib/images/service";
import { runOneImage, recoverImageLeases } from "../src/lib/images/worker";
import { reconcileImage } from "../src/lib/images/reconcile";
import { heartbeat } from "../src/lib/production/readiness";
import { uploadAsset, changeAsset } from "../src/lib/assets/service";
import { manageComposition, exportComposition } from "../src/lib/composition/service";
import { authorizeSupplier } from "../src/lib/production/budget";
import type { AssetStore } from "../src/lib/assets/storage";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local test DB required");
suite("image production lifecycle", () => {
  const orgs: string[] = [], users: string[] = [], workerId = `image-fixture-${crypto.randomUUID()}`, objects = new Map<string, Buffer>();
  const store: AssetStore = { put: async (key, bytes, _mime, immutable) => { if (immutable && objects.has(key)) throw Error("immutable"); objects.set(key, Buffer.from(bytes)); }, get: async key => { const value = objects.get(key); if (!value) throw Error("missing"); return value; }, remove: async key => { objects.delete(key); } };
  beforeEach(async () => {
    vi.stubEnv("GEMINI_API_KEY", "fixture-never-network"); vi.stubEnv("PAID_EXECUTION_ENABLED", "true");
    vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "50000000"); vi.stubEnv("TOTAL_SUPPLIER_BUDGET_MICROS", "1000000000");
    vi.stubEnv("IMAGE_RATE_CARD_JSON", JSON.stringify([{ model: "gemini-fixture", lane: "creative", inputUsdPerMillion: 2, outputUsdPerMillion: 8, maxOutputTokens: 4096, verifiedUntil: "2099-01-01T00:00:00Z" }, { model: "gemini-fixture-revision", lane: "revision", inputUsdPerMillion: 1, outputUsdPerMillion: 4, maxOutputTokens: 4096, verifiedUntil: "2099-01-01T00:00:00Z" }]));
    await heartbeat(workerId);
  });
  afterAll(async () => {
    const rows = await db.imageGeneration.findMany({ where: { organizationId: { in: orgs } } });
    await db.supplierAuthorization.deleteMany({ where: { key: { in: rows.map(r => r.id) } } });
    await db.brandAsset.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.imageGeneration.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.user.deleteMany({ where: { id: { in: users } } });
    await db.workerHeartbeat.deleteMany({ where: { id: workerId } }); vi.unstubAllEnvs(); await db.$disconnect();
  });
  async function setup() {
    const user = await db.user.create({ data: { email: `image-${crypto.randomUUID()}@example.test`, name: "Image fixture", passwordHash: "no-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "IMAGE FIXTURE", wallet: { create: { available: 1000, revisionAvailable: 100 } }, memberships: { create: { userId: user.id, role: "OWNER" } } } }); orgs.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Fixture Architecture", offering: "Design consultations", confirmedAt: new Date() } });
    const plan = await db.productionPlan.create({ data: { organizationId: org.id, businessId: business.id, brandVersion: 1, title: "Fixture plan", creditCeiling: 0, items: { create: { title: "A considered home", channel: "Instagram", format: "static", brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: { headline: "A considered home", caption: "Explore considered design", cta: "Meet us", visualDirection: "Warm architectural light", rationale: "A calm introduction", evidenceUsed: [] } } } } } }, include: { items: { include: { revisions: true } } } });
    const image = await sharp({ create: { width: 128, height: 128, channels: 4, background: "#aa9977" } }).png().toBuffer();
    const scope = { businessId: business.id, organizationId: org.id, actorId: user.id };
    return { scope, item: plan.items[0], image, generate: vi.fn(async () => ({ id: "fixture-provider-response", image, usage: { promptTokenCount: 100, candidatesTokenCount: 100, totalTokenCount: 200 } })) };
  }
  async function quote(f: Awaited<ReturnType<typeof setup>>, extra = {}) {
    const r = await manageImage(f.scope, { action: "quote", itemId: f.item.id, ...extra }, () => store); return r.generationId!;
  }
  async function accept(f: Awaited<ReturnType<typeof setup>>, id?: string) {
    const generationId = id || await quote(f); await manageImage(f.scope, { action: "accept", generationId }, () => store); return generationId;
  }
  async function row(id: string) { return db.imageGeneration.findUniqueOrThrow({ where: { id }, include: { output: true } }); }
  async function wallet(f: Awaited<ReturnType<typeof setup>>) { return db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } }); }
  it("quotes without expense, accepts once and produces a private unapproved image once", async () => {
    const f = await setup(), id = await quote(f); expect((await wallet(f)).held).toBe(0);
    await Promise.all([1, 2].map(() => accept(f, id))); expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(1);
    await runOneImage(f.generate, () => store); await runOneImage(f.generate, () => store); expect(f.generate).toHaveBeenCalledTimes(1);
    expect(await row(id)).toMatchObject({ status: "READY", supplierCostMicros: 1000, output: { status: "READY", approvedForGeneration: false } });
    expect(await wallet(f)).toMatchObject({ available: 999, held: 0 });
    expect((await previewImage(f.scope, id, store)).length).toBeGreaterThan(0);
    await expect(changeAsset(f.scope, (await row(id)).output!.id, { action: "approve", approved: true })).rejects.toThrow("cannot bypass");
  });
  it("requires human review and composes approved generated artwork with exact originals", async () => {
    const f = await setup(), logo = await uploadAsset(f.scope, { label: "Exact logo", purpose: "logo", rightsConfirmed: true }, f.image, store);
    await changeAsset(f.scope, logo.asset.id, { action: "approve", approved: true });
    const id = await accept(f); await runOneImage(f.generate, () => store);
    await expect(manageImage(f.scope, { action: "approve", generationId: id }, () => store)).rejects.toThrow();
    await manageImage(f.scope, { action: "approve", generationId: id, fidelityReviewed: true }, () => store);
    const composition = await manageComposition(f.scope, { action: "create", itemId: f.item.id, revisionVersion: 1 });
    expect(JSON.stringify(composition.composition.document)).toContain((await row(id)).output!.id); expect(JSON.stringify(composition.composition.document)).toContain(logo.asset.id);
    await manageComposition(f.scope, { action: "approve", rendererVersion: "static-outlines-v2", itemId: f.item.id, version: composition.composition.version });
    expect((await exportComposition(f.scope, composition.composition.id, "square", false, store)).width).toBe(1080);
    await manageImage(f.scope, { action: "reject", generationId: id }, () => store);
    await expect(exportComposition(f.scope, composition.composition.id, "square", false, store)).rejects.toThrow("changed");
  });
  it("binds revisions to parent bytes, uses revision credits and revokes old approval on acceptance", async () => {
    const f = await setup(), id = await accept(f); await runOneImage(f.generate, () => store);
    await manageImage(f.scope, { action: "approve", generationId: id, fidelityReviewed: true }, () => store);
    const revision = await quote(f, { parentId: id, feedback: "Use a warmer background; keep framing." });
    expect((await row(id)).status).toBe("APPROVED");
    expect((await row(revision)).route).toMatchObject({ model: { lane: "revision" } });
    await accept(f, revision); expect((await row(id)).status).toBe("SUPERSEDED");
    await runOneImage(f.generate, () => store);
    expect(f.generate.mock.calls.length).toBe(2);
    const calls = f.generate.mock.calls as unknown as [{ references: Buffer[] }][];
    expect(calls[1][0].references).toHaveLength(1);
    expect(await wallet(f)).toMatchObject({ available: 999, revisionAvailable: 99, held: 0 });
  });
  it("holds uncertain requests, never retries and requires idempotent operator reconciliation", async () => {
    const f = await setup(), id = await accept(f), failure = vi.fn(async () => { throw Error("timeout"); });
    await runOneImage(failure, () => store); await runOneImage(failure, () => store); expect(failure).toHaveBeenCalledTimes(1);
    expect((await row(id)).status).toBe("NEEDS_RECONCILIATION"); expect((await wallet(f)).held).toBeGreaterThan(0);
    await expect(quote(f)).rejects.toThrow("Resolve");
    const resolution = { generationId: id, supplierCostMicros: 1000, evidence: "Fixture provider billing inspected independently", operatorId: "test-operator" };
    await reconcileImage(resolution); await reconcileImage(resolution);
    await expect(reconcileImage({ ...resolution, supplierCostMicros: 999 })).rejects.toThrow("replay changed");
    expect(await wallet(f)).toMatchObject({ available: 1000, held: 0 });
  });
  it("charges no customer credits for malformed results but records supplier usage", async () => {
    const f = await setup(), id = await accept(f);
    await runOneImage(async () => ({ ...await f.generate(), image: Buffer.from("<svg>unsafe</svg>") }), () => store);
    expect(await row(id)).toMatchObject({ status: "FAILED", supplierCostMicros: 1000, output: { status: "ARCHIVED", approvedForGeneration: false } });
    expect(await wallet(f)).toMatchObject({ available: 1000, held: 0 });
  });
  it("quarantines ambiguous storage writes without regeneration or customer charge", async () => {
    const f = await setup(), id = await accept(f);
    await runOneImage(f.generate, () => ({ ...store, put: async (key, bytes) => { objects.set(key, bytes); throw Error("lost acknowledgement"); } }));
    expect(await row(id)).toMatchObject({ status: "FAILED", supplierCostMicros: 1000, output: { status: "ARCHIVED" } });
    expect(await wallet(f)).toMatchObject({ available: 1000, held: 0 });
    await expect(previewImage(f.scope, id, store)).rejects.toThrow("unavailable");
    await runOneImage(f.generate, () => store); expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("revoked references stop before the paid call and release the hold", async () => {
    const f = await setup(), asset = await uploadAsset(f.scope, { label: "Style", purpose: "reference", rightsConfirmed: true }, f.image, store);
    await changeAsset(f.scope, asset.asset.id, { action: "approve", approved: true });
    const id = await accept(f); await changeAsset(f.scope, asset.asset.id, { action: "approve", approved: false });
    await runOneImage(f.generate, () => store); expect(f.generate).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ status: "FAILED", errorCode: "PREFLIGHT_FAILED", output: { status: "DELETED", bytes: 0 } });
    expect((await wallet(f)).held).toBe(0);
  });
  it("copy changes during submission prevent delivery while recording the expense", async () => {
    const f = await setup(), id = await accept(f);
    await runOneImage(async () => { await db.creativeRevision.update({ where: { id: f.item.revisions[0].id }, data: { status: "READY" } }); return f.generate(); }, () => store);
    expect(await row(id)).toMatchObject({ status: "FAILED", supplierCostMicros: 1000 }); expect((await wallet(f)).available).toBe(1000);
  });
  it("isolates business reads, quote acceptance and generated previews", async () => {
    const a = await setup(), b = await setup(), id = await accept(a); await runOneImage(a.generate, () => store);
    await expect(manageImage(b.scope, { action: "accept", generationId: id }, () => store)).rejects.toThrow("not found");
    await expect(previewImage(b.scope, id, store)).rejects.toThrow("unavailable");
    expect((await listImages(b.scope)).images).toHaveLength(0);
    await db.membership.delete({ where: { organizationId_userId: { organizationId: a.scope.organizationId, userId: a.scope.actorId } } });
    await expect(listImages(a.scope)).rejects.toThrow("not found");
    await expect(previewImage(a.scope, id, store)).rejects.toThrow("not found");
  });
  it("cancels a queued request, releases storage and credits and makes no provider call", async () => {
    const f = await setup(), id = await accept(f);
    await manageImage(f.scope, { action: "cancel", generationId: id }, () => store); await manageImage(f.scope, { action: "cancel", generationId: id }, () => store);
    await runOneImage(f.generate, () => store); expect(f.generate).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ status: "CANCELLED", output: { status: "DELETED", bytes: 0 } }); expect((await wallet(f)).available).toBe(1000);
  });
  it("recovers pre-submit leases but never requeues submitted calls", async () => {
    const f = await setup(), id = await accept(f);
    await db.imageGeneration.update({ where: { id }, data: { status: "RUNNING", leaseUntil: new Date(0) } }); await recoverImageLeases(); expect((await row(id)).status).toBe("QUEUED");
    await db.imageGeneration.update({ where: { id }, data: { status: "SUBMITTING", leaseUntil: new Date(0), submittedAt: new Date() } }); await recoverImageLeases(); expect((await row(id)).status).toBe("NEEDS_RECONCILIATION");
    await runOneImage(f.generate, () => store); expect(f.generate).not.toHaveBeenCalled();
    await reconcileImage({ generationId: id, supplierCostMicros: 0, evidence: "Fixture independently verified no expense", operatorId: "test-operator" });
  });
  it("shares supplier caps with copy and brand analysis and refuses paused generation", async () => {
    const f = await setup(), id = await accept(f); vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "1");
    await expect(db.$transaction(tx => authorizeSupplier(tx, `blocked-${id}`, 1))).rejects.toThrow("supplier-spend limit");
    await manageImage(f.scope, { action: "cancel", generationId: id }, () => store);
    vi.stubEnv("PAID_EXECUTION_ENABLED", "false"); await expect(quote(f)).rejects.toThrow("paused");
  });
  it("enforces an independent reviewer when configured", async () => {
    const f = await setup(), id = await accept(f); await runOneImage(f.generate, () => store);
    await db.business.update({ where: { id: f.scope.businessId }, data: { independentApproval: true } });
    await expect(manageImage(f.scope, { action: "approve", generationId: id, fidelityReviewed: true }, () => store)).rejects.toThrow();
    expect((await row(id)).status).toBe("READY");
  });
  it("revocation of an input reference blocks final composed exports as well as new generation", async () => {
    const f = await setup(), ref = await uploadAsset(f.scope, { label: "Style reference", purpose: "reference", rightsConfirmed: true }, f.image, store);
    await changeAsset(f.scope, ref.asset.id, { action: "approve", approved: true });
    const id = await accept(f); await runOneImage(f.generate, () => store);
    await manageImage(f.scope, { action: "approve", generationId: id, fidelityReviewed: true }, () => store);
    const { composition } = await manageComposition(f.scope, { action: "create", itemId: f.item.id, revisionVersion: 1 });
    await manageComposition(f.scope, { action: "approve", rendererVersion: "static-outlines-v2", itemId: f.item.id, version: composition.version });
    await changeAsset(f.scope, ref.asset.id, { action: "approve", approved: false });
    await expect(exportComposition(f.scope, composition.id, "square", false, store)).rejects.toThrow("reference changed");
  });
  it("an identical approval replay does not invalidate an already approved composition", async () => {
    const f = await setup(), id = await accept(f); await runOneImage(f.generate, () => store);
    const approval = { action: "approve", generationId: id, fidelityReviewed: true };
    await manageImage(f.scope, approval, () => store);
    const { composition } = await manageComposition(f.scope, { action: "create", itemId: f.item.id, revisionVersion: 1 });
    await manageComposition(f.scope, { action: "approve", rendererVersion: "static-outlines-v2", itemId: f.item.id, version: composition.version });
    await manageImage(f.scope, approval, () => store);
    expect((await db.staticComposition.findUniqueOrThrow({ where: { id: composition.id } })).status).toBe("APPROVED");
  });
  it("expired quotes and insufficient credits cannot create a job or supplier authorization", async () => {
    const f = await setup(), expired = await quote(f);
    await db.imageGeneration.update({ where: { id: expired }, data: { expiresAt: new Date(0) } });
    await expect(accept(f, expired)).rejects.toThrow("expired");
    const id = await quote(f); await db.wallet.update({ where: { organizationId: f.scope.organizationId }, data: { available: 0, revisionAvailable: 0 } });
    await expect(accept(f, id)).rejects.toThrow();
    expect(await db.supplierAuthorization.findUnique({ where: { key: id } })).toBeNull();
    expect((await row(id)).output).toBeNull(); expect((await row(id)).status).toBe("OFFERED");
  });
  it("revoked editor access before worker submission releases credits without a call", async () => {
    const f = await setup(), id = await accept(f);
    await db.membership.update({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } }, data: { role: "VIEWER" } });
    await runOneImage(f.generate, () => store); expect(f.generate).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ status: "FAILED", errorCode: "PREFLIGHT_FAILED" }); expect((await wallet(f)).held).toBe(0);
  });
  it("storage tampering prevents a generated preview", async () => {
    const f = await setup(), id = await accept(f); await runOneImage(f.generate, () => store);
    objects.set((await row(id)).output!.objectKey, Buffer.from("tampered"));
    await expect(previewImage(f.scope, id, store)).rejects.toThrow("integrity check failed");
  });
});
