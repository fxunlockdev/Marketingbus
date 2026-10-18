import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { db } from "../src/lib/db";
import { manageVideo, storyboardContext, readMotion } from "../src/lib/video/service";
import { runOneMotion } from "../src/lib/video/worker";
import { manageShotGeneration, listShotGenerations } from "../src/lib/video/generation-service";
import { runOneShotGeneration, recoverShotGenerations } from "../src/lib/video/generation-worker";
import { reconcileShotGeneration } from "../src/lib/video/generation-reconcile";
import { runOneClip, reviewClip, readClip, listClips, recoverClipLeases, recoverClipStorage } from "../src/lib/video/clips";
import { configuredShotAdapters, selectShotRoute, shotConfigurationHash, type ShotAdapter } from "../src/lib/video/generation-contracts";
import { storyboardDocument } from "../src/lib/video/document";
import { WORKER_RUNTIME, workerConfigurationHash } from "../src/lib/production/readiness";
import { authorizeSupplier } from "../src/lib/production/budget";
import { createHiggsfieldShotAdapter } from "../src/lib/video/higgsfield-adapter";
import type { AssetStore } from "../src/lib/assets/storage";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local test DB required");
suite("generated-shot authorization, asynchronous receipts and delivery", () => {
  const orgs: string[] = [], users: string[] = [], extras: string[] = [], workerId = `shot-fixture-${crypto.randomUUID()}`, objects = new Map<string, Buffer>();
  const rate = { provider: "fixture", accountId: "test-account", adapterVersion: "v1", model: "test-video", durationMs: 5000, ceilingMicros: 100000, verifiedUntil: "2099-01-01T00:00:00Z" };
  const source = Buffer.from("000000186674797069736f6d0000020069736f6d6d703432", "hex"), processed = { bytes: Buffer.from("test-only silent output"), durationMs: 5000 };
  const store: AssetStore = { put: async (key, bytes, _mime, immutable) => { if (immutable && objects.has(key)) throw Error("immutable"); objects.set(key, Buffer.from(bytes)); }, get: async key => { const b = objects.get(key); if (!b) throw Error("missing"); return b; }, remove: async key => { objects.delete(key); } };
  async function worker() { await db.workerHeartbeat.upsert({ where: { id: workerId }, create: { id: workerId, runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), executionEnabled: true, motionReady: true }, update: { runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), executionEnabled: true, motionReady: true, lastSeenAt: new Date() } }); }
  beforeEach(async () => {
    vi.stubEnv("PAID_EXECUTION_ENABLED", "true"); vi.stubEnv("MOTION_RENDERING_ENABLED", "true"); vi.stubEnv("MOTION_RENDER_DAILY_LIMIT", "100");
    vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "50000000"); vi.stubEnv("TOTAL_SUPPLIER_BUDGET_MICROS", "1000000000");
    vi.stubEnv("VIDEO_RATE_CARD_JSON", JSON.stringify([rate])); await worker();
  });
  afterEach(async () => {
    const jobs = await db.videoGeneration.findMany({ where: { organizationId: { in: orgs } } }), clips = await db.videoClip.findMany({ where: { organizationId: { in: orgs } } }), renders = await db.motionRender.findMany({ where: { organizationId: { in: orgs } } });
    await db.motionAuthorization.deleteMany({ where: { key: { in: [...clips, ...renders].map(c => c.id) } } });
    await db.supplierAuthorization.deleteMany({ where: { key: { in: [...jobs.map(j => j.id), ...extras] } } });
    await db.videoClip.deleteMany({ where: { organizationId: { in: orgs } } }); await db.videoGeneration.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.motionRender.deleteMany({ where: { organizationId: { in: orgs } } }); await db.videoStoryboard.deleteMany({ where: { organizationId: { in: orgs } } }); await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.user.deleteMany({ where: { id: { in: users } } });
    orgs.length = users.length = extras.length = 0; objects.clear(); vi.unstubAllEnvs();
  });
  afterAll(async () => { await db.workerHeartbeat.deleteMany({ where: { id: workerId } }); await db.$disconnect(); });
  async function setup() {
    const user = await db.user.create({ data: { email: `shot-${crypto.randomUUID()}@example.test`, name: "Shot fixture", passwordHash: "no-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "SHOT FIXTURE", memberships: { create: { userId: user.id, role: "OWNER" } }, wallet: { create: { available: 100, revisionAvailable: 20 } } } }); orgs.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Architecture studio", offering: "Design consultations", confirmedAt: new Date() } });
    const plan = await db.productionPlan.create({ data: { organizationId: org.id, businessId: business.id, brandVersion: 1, title: "Local plan", creditCeiling: 0, items: { create: { title: "Considered spaces", channel: "YouTube", format: "motion", brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: {} } } } } }, include: { items: { include: { revisions: true } } } });
    const scope = { businessId: business.id, organizationId: org.id, actorId: user.id };
    const boardId = (await manageVideo(scope, { action: "create", itemId: plan.items[0].id }, () => store)).storyboardId!;
    const doc = storyboardDocument.parse((await db.videoStoryboard.findUniqueOrThrow({ where: { id: boardId } })).document);
    for (const shot of doc.shots) await manageVideo(scope, { action: "review-shot", storyboardId: boardId, shotId: shot.id, approved: true }, () => store);
    await manageVideo(scope, { action: "approve-storyboard", storyboardId: boardId }, () => store);
    const submit = vi.fn(async (input: Parameters<ShotAdapter["submit"]>[0]) => ({ requestId: input.requestId, providerJobId: `job-${input.requestId}`, accountId: rate.accountId }));
    const poll = vi.fn(async (input: Parameters<ShotAdapter["poll"]>[0]): Promise<unknown> => ({ requestId: input.requestId, providerJobId: input.providerJobId, accountId: rate.accountId, model: rate.model, status: "succeeded", costMicros: 60000, bytes: source }));
    const adapters: ShotAdapter[] = [{ id: rate.provider, version: rate.adapterVersion, accountId: rate.accountId, submit, poll }];
    return { scope, boardId, shotId: doc.shots[0].id, revisionId: plan.items[0].revisions[0].id, adapters, submit, poll };
  }
  type Fixture = Awaited<ReturnType<typeof setup>>;
  const row = (id: string) => db.videoGeneration.findUniqueOrThrow({ where: { id }, include: { output: true } });
  const wallet = (f: Fixture) => db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } });
  async function quote(f: Fixture) { return (await manageShotGeneration(f.scope, { action: "quote", storyboardId: f.boardId, shotId: f.shotId }, f.adapters, () => store)).generationId!; }
  async function accept(f: Fixture, existing?: string) { const id = existing || await quote(f); await manageShotGeneration(f.scope, { action: "accept", generationId: id, rightsConfirmed: true }, f.adapters, () => store); return id; }
  async function due(id: string) { await db.videoGeneration.update({ where: { id }, data: { nextPollAt: new Date(0) } }); }
  async function ingested(f: Fixture) { const id = await accept(f); await runOneShotGeneration(f.adapters, () => store); await due(id); await runOneShotGeneration(f.adapters, () => store); return id; }
  it("quotes freely, holds once, submits once, settles only normalized footage and requires human review", async () => {
    const f = await setup(), id = await quote(f); expect(await wallet(f)).toMatchObject({ available: 100, held: 0 });
    await Promise.all([accept(f, id), accept(f, id)]); expect(await wallet(f)).toMatchObject({ available: 90, held: 10, revisionAvailable: 20 });
    await Promise.all([runOneShotGeneration(f.adapters, () => store), runOneShotGeneration(f.adapters, () => store)]); expect(f.submit).toHaveBeenCalledTimes(1);
    await due(id); await Promise.all([runOneShotGeneration(f.adapters, () => store), runOneShotGeneration(f.adapters, () => store)]); expect(f.poll).toHaveBeenCalledTimes(1);
    const q = await row(id); expect(q).toMatchObject({ status: "INGESTING", output: { status: "QUEUED" } }); expect((await wallet(f)).held).toBe(10);
    await expect(readClip(f.scope, q.output!.id, store)).rejects.toThrow("processed");
    await runOneClip(async () => processed, () => store); expect(await row(id)).toMatchObject({ status: "READY", supplierCostMicros: 60000, output: { status: "READY", approvedBy: null } });
    expect(await wallet(f)).toMatchObject({ available: 94, held: 0, revisionAvailable: 20 });
    const clip = (await row(id)).output!; await reviewClip(f.scope, clip.id, { action: "approve", watched: true });
    const document = storyboardDocument.parse((await db.videoStoryboard.findUniqueOrThrow({ where: { id: f.boardId } })).document); document.shots[0].clip = { id: clip.id, sha256: clip.sha256 };
    const next = (await manageVideo(f.scope, { action: "save", storyboardId: f.boardId, document }, () => store)).storyboardId!;
    expect((await storyboardContext(f.scope, next)).clips).toHaveLength(1); expect(await readClip(f.scope, clip.id, store)).toEqual(processed.bytes);
    await db.creativeRevision.update({ where: { id: f.revisionId }, data: { status: "REJECTED" } });
    await expect(readClip(f.scope, clip.id, store)).rejects.toThrow("source brand or approved copy");
    expect((await listClips(f.scope)).find(c => c.id === clip.id)?.usable).toBe(false);
  });
  it("keeps production adapter registration empty and refuses unverified prices", async () => {
    const f = await setup(); expect(configuredShotAdapters()).toEqual([]);
    await expect(manageShotGeneration(f.scope, { action: "quote", storyboardId: f.boardId, shotId: f.shotId }, undefined, () => store)).rejects.toThrow("verified provider");
    expect((await wallet(f)).held).toBe(0);
    vi.stubEnv("VIDEO_RATE_CARD_JSON", JSON.stringify([{ ...rate, verifiedUntil: "2000-01-01T00:00:00Z" }])); expect(() => selectShotRoute(5000, f.adapters)).toThrow("verified provider");
  });
  it.each(["viewer", "tenant", "unapproved", "expiry", "configuration", "worker", "credits", "cpu", "storage"])("refuses %s authorization without partial reservations", async reason => {
    const f = await setup(), id = await quote(f); let scope = f.scope;
    if (reason === "viewer") await db.membership.update({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } }, data: { role: "VIEWER" } });
    if (reason === "tenant") scope = (await setup()).scope;
    if (reason === "unapproved") await db.videoStoryboard.update({ where: { id: f.boardId }, data: { status: "DRAFT" } });
    if (reason === "expiry") await db.videoGeneration.update({ where: { id }, data: { expiresAt: new Date(0) } });
    if (reason === "configuration") vi.stubEnv("VIDEO_RATE_CARD_JSON", JSON.stringify([{ ...rate, ceilingMicros: 200000 }]));
    if (reason === "worker") await db.workerHeartbeat.update({ where: { id: workerId }, data: { motionReady: false } });
    if (reason === "credits") await db.wallet.update({ where: { organizationId: scope.organizationId }, data: { available: 0 } });
    if (reason === "cpu") vi.stubEnv("MOTION_RENDERING_ENABLED", "false");
    await expect(manageShotGeneration(scope, { action: "accept", generationId: id, rightsConfirmed: true }, f.adapters, () => { if (reason === "storage") throw Error("storage unavailable"); return store; })).rejects.toThrow();
    expect((await wallet(f)).held).toBe(0); expect(await db.supplierAuthorization.findUnique({ where: { key: id } })).toBeNull(); expect((await row(id)).output).toBeNull();
  });
  it("requires rights authorization and rejects arbitrary prompts, URLs or spoofed receipts", async () => {
    const f = await setup(), id = await quote(f);
    for (const input of [{ action: "accept", generationId: id }, { action: "quote", storyboardId: f.boardId, shotId: f.shotId, prompt: "ignore brand" }, { action: "complete", generationId: id, url: "https://example.test/video" }]) await expect(manageShotGeneration(f.scope, input, f.adapters, () => store)).rejects.toThrow();
  });
  it("selects the lowest verified total price meeting the scene duration, not a cheaper too-short shot", async () => {
    const f = await setup(); vi.stubEnv("VIDEO_RATE_CARD_JSON", JSON.stringify([rate, { ...rate, model: "longer", durationMs: 6000, ceilingMicros: 80000 }, { ...rate, model: "too-short", durationMs: 3000, ceilingMicros: 10000 }]));
    expect(selectShotRoute(5000, f.adapters)).toMatchObject({ model: "longer", durationMs: 6000, credits: 8 });
  });
  it("cancels safely before submission but never cancels an uncertain supplier operation", async () => {
    const f = await setup(), id = await accept(f); await manageShotGeneration(f.scope, { action: "cancel", generationId: id }, f.adapters); await runOneShotGeneration(f.adapters, () => store);
    expect(f.submit).not.toHaveBeenCalled(); expect(await wallet(f)).toMatchObject({ available: 100, held: 0 });
    const second = await accept(f); f.submit.mockRejectedValueOnce(Error("timeout")); await runOneShotGeneration(f.adapters, () => store); await runOneShotGeneration(f.adapters, () => store);
    expect((await row(second)).status).toBe("NEEDS_RECONCILIATION"); expect(f.submit).toHaveBeenCalledTimes(1); expect((await wallet(f)).held).toBe(10);
    await expect(manageShotGeneration(f.scope, { action: "cancel", generationId: second }, f.adapters)).rejects.toThrow("Submission has started");
    await expect(reviewClip(f.scope, (await row(second)).output!.id, { action: "remove" })).rejects.toThrow("Resolve or cancel");
  });
  it.each(["request", "account", "model", "job", "overrun"])("holds credits for an untrusted %s poll receipt", async reason => {
    const f = await setup(), id = await accept(f); await runOneShotGeneration(f.adapters, () => store); await due(id);
    f.poll.mockImplementationOnce(async x => ({ requestId: reason === "request" ? "wrong" : x.requestId, providerJobId: reason === "job" ? "wrong" : x.providerJobId, accountId: reason === "account" ? "wrong" : rate.accountId, model: reason === "model" ? "wrong" : rate.model, status: "succeeded", costMicros: reason === "overrun" ? 200000 : 60000, bytes: source }));
    await runOneShotGeneration(f.adapters, () => store); expect((await row(id)).status).toBe("NEEDS_RECONCILIATION"); expect((await wallet(f)).held).toBe(10); expect(objects.size).toBe(0);
  });
  it.each(["failed", "invalid-media", "stale-brand", "demoted"])("records known expense and refunds unusable %s output", async reason => {
    const f = await setup(), id = await accept(f); await runOneShotGeneration(f.adapters, () => store); await due(id);
    if (reason === "stale-brand") await db.business.update({ where: { id: f.scope.businessId }, data: { version: { increment: 1 } } });
    if (reason === "demoted") await db.membership.update({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } }, data: { role: "VIEWER" } });
    if (["failed", "invalid-media"].includes(reason)) f.poll.mockImplementationOnce(async x => ({ requestId: x.requestId, providerJobId: x.providerJobId, accountId: rate.accountId, model: rate.model, costMicros: 60000, ...(reason === "failed" ? { status: "failed" } : { status: "succeeded", bytes: Buffer.from("not MP4") }) }));
    await runOneShotGeneration(f.adapters, () => store); expect(await row(id)).toMatchObject({ status: "FAILED", supplierCostMicros: 60000 }); expect(await wallet(f)).toMatchObject({ available: 100, held: 0 });
  });
  it("backs off pending polls and stops at the persisted ceiling without resubmission", async () => {
    const f = await setup(), id = await accept(f); await runOneShotGeneration(f.adapters, () => store); await due(id);
    f.poll.mockImplementation(async x => ({ requestId: x.requestId, providerJobId: x.providerJobId, accountId: rate.accountId, model: rate.model, status: "pending" }));
    await runOneShotGeneration(f.adapters, () => store); expect((await row(id)).nextPollAt!.getTime()).toBeGreaterThan(Date.now()); await runOneShotGeneration(f.adapters, () => store); expect(f.poll).toHaveBeenCalledTimes(1);
    await db.videoGeneration.update({ where: { id }, data: { pollCount: 19, nextPollAt: new Date(0) } }); await runOneShotGeneration(f.adapters, () => store);
    expect((await row(id)).status).toBe("NEEDS_RECONCILIATION"); expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it.each(["decoder", "duration", "context", "storage", "lease"])("releases credits when normalization fails at %s", async reason => {
    const f = await setup(), id = await ingested(f), clip = (await row(id)).output!;
    const processor = vi.fn(async () => { if (reason === "decoder") throw Error("bad bytes"); if (reason === "context") await db.videoStoryboard.update({ where: { id: f.boardId }, data: { status: "DRAFT" } }); return { ...processed, durationMs: reason === "duration" ? 4000 : 5000 }; });
    if (reason === "lease") {
      await db.videoClip.update({ where: { id: clip.id }, data: { status: "RUNNING", leaseUntil: new Date(0) } }); await recoverClipLeases();
    } else await runOneClip(processor, () => reason === "storage" ? { ...store, put: async (...args) => { await store.put(...args); throw Error("lost acknowledgement"); } } : store);
    expect(await row(id)).toMatchObject({ status: "FAILED", supplierCostMicros: 60000 }); expect(await wallet(f)).toMatchObject({ available: 100, held: 0 });
    await expect(recoverClipStorage(f.scope, clip.id, store)).rejects.toThrow("not deliverable");
  });
  it("reconciles uncertain expense once, including an overrun in future supplier capacity", async () => {
    const f = await setup(), id = await accept(f); f.submit.mockRejectedValueOnce(Error("timeout")); await runOneShotGeneration(f.adapters, () => store);
    const input = { generationId: id, supplierCostMicros: 150000, operatorId: "test-operator", evidence: "Verified final supplier invoice test evidence" };
    await reconcileShotGeneration(input); await reconcileShotGeneration(input);
    await expect(reconcileShotGeneration({ ...input, supplierCostMicros: 140000 })).rejects.toThrow("replay changed");
    expect(await wallet(f)).toMatchObject({ available: 100, held: 0 }); expect((await db.supplierAuthorization.findUniqueOrThrow({ where: { key: id } })).ceilingMicros).toBe(150000);
  });
  it("keeps older unresolved video expense in the shared daily allowance", async () => {
    const f = await setup(), id = await accept(f); const yesterday = new Date(Date.now() - 2 * 86400000);
    await db.supplierAuthorization.update({ where: { key: id }, data: { createdAt: yesterday } }); await db.videoGeneration.update({ where: { id }, data: { acceptedAt: yesterday, status: "NEEDS_RECONCILIATION" } });
    vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "100000"); const key = crypto.randomUUID(); extras.push(key);
    await expect(db.$transaction(tx => authorizeSupplier(tx, key, 1))).rejects.toThrow("supplier-spend limit");
  });
  it("recovers only pre-submit work and fences late submission responses", async () => {
    const f = await setup(), id = await accept(f); await db.videoGeneration.update({ where: { id }, data: { status: "RUNNING", leaseUntil: new Date(0) } }); await recoverShotGenerations(); expect((await row(id)).status).toBe("QUEUED");
    f.submit.mockImplementationOnce(async input => {
      await db.videoGeneration.update({ where: { id }, data: { leaseUntil: new Date(0) } }); await recoverShotGenerations();
      return { requestId: input.requestId, providerJobId: `late-${id}`, accountId: rate.accountId };
    });
    await runOneShotGeneration(f.adapters, () => store); expect((await row(id)).status).toBe("NEEDS_RECONCILIATION"); expect((await row(id)).providerJobId).toBeNull(); expect((await wallet(f)).held).toBe(10);
  });
  it("counts an older job settled today in today's shared supplier allowance", async () => {
    const f = await setup(), id = await ingested(f), yesterday = new Date(Date.now() - 2 * 86400000);
    await db.supplierAuthorization.update({ where: { key: id }, data: { createdAt: yesterday } });
    await db.videoGeneration.update({ where: { id }, data: { acceptedAt: yesterday, submittedAt: yesterday } });
    await runOneClip(async () => processed, () => store); expect((await row(id)).settledAt).not.toBeNull();
    vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "100000"); const key = crypto.randomUUID(); extras.push(key);
    await expect(db.$transaction(tx => authorizeSupplier(tx, key, 1))).rejects.toThrow("supplier-spend limit");
  });
  it("returns only scoped customer status, without private prompt, receipts or supplier pricing", async () => {
    const f = await setup(), id = await quote(f), other = await setup();
    const result = await listShotGenerations(f.scope); expect(result.jobs.map(j => j.id)).toContain(id);
    const text = JSON.stringify(result); for (const secret of ["prompt", "configurationHash", "supplierCeilingMicros", "providerJobId", "receipt"]) expect(text).not.toContain(secret);
    expect((await listShotGenerations(other.scope)).jobs).toEqual([]); expect(shotConfigurationHash()).toHaveLength(64);
  });
  it("holds a second job rather than binding two authorizations to one supplier job", async () => {
    const f = await setup(), first = await accept(f); await runOneShotGeneration(f.adapters, () => store);
    const g = await setup(), second = await accept(g); g.submit.mockImplementationOnce(async x => ({ requestId: x.requestId, providerJobId: (await row(first)).providerJobId!, accountId: rate.accountId }));
    await runOneShotGeneration(g.adapters, () => store); expect((await row(second)).status).toBe("NEEDS_RECONCILIATION"); expect((await row(first)).status).toBe("POLLING"); expect((await wallet(g)).held).toBe(10);
  });
  it.each(["raw-storage", "raw-integrity", "oversized"])("quarantines %s failures and does not retry a paid generation", async reason => {
    const f = await setup(), id = await accept(f); await runOneShotGeneration(f.adapters, () => store); await due(id);
    if (reason === "oversized") f.poll.mockImplementationOnce(async x => ({ requestId: x.requestId, providerJobId: x.providerJobId, accountId: rate.accountId, model: rate.model, status: "succeeded", costMicros: 60000, bytes: Buffer.alloc(21 * 1024 * 1024) }));
    const failingStore = { ...store, put: async (...args: Parameters<AssetStore["put"]>) => { await store.put(...args); if (reason === "raw-storage") throw Error("acknowledgement lost"); }, get: async (key: string) => reason === "raw-integrity" ? Buffer.from("tampered") : store.get(key) };
    await runOneShotGeneration(f.adapters, () => failingStore); await runOneShotGeneration(f.adapters, () => store);
    expect(await row(id)).toMatchObject({ status: "FAILED", supplierCostMicros: 60000, output: { status: "FAILED" } }); expect((await wallet(f)).held).toBe(0); expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("recovers interrupted read-only polling without a second submission", async () => {
    const f = await setup(), id = await accept(f); await runOneShotGeneration(f.adapters, () => store);
    await db.videoGeneration.update({ where: { id }, data: { leaseUntil: new Date(0), pollCount: 1 } }); await recoverShotGenerations();
    expect(await row(id)).toMatchObject({ status: "POLLING", leaseUntil: null }); await due(id); await runOneShotGeneration(f.adapters, () => store);
    expect((await row(id)).status).toBe("INGESTING"); expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it.each(["queue", "normalization"])("expires abandoned %s work without stranding customer credits", async stage => {
    const f = await setup(), id = stage === "queue" ? await accept(f) : await ingested(f);
    await db.videoGeneration.update({ where: { id }, data: { acceptedAt: new Date(Date.now() - 7200000) } }); await recoverShotGenerations();
    expect((await row(id)).status).toBe("FAILED"); expect(await wallet(f)).toMatchObject({ available: 100, held: 0 });
  });
  it("revokes generated footage after the source storyboard approval is withdrawn", async () => {
    const f = await setup(), id = await ingested(f); await runOneClip(async () => processed, () => store);
    const clip = (await row(id)).output!; await reviewClip(f.scope, clip.id, { action: "approve", watched: true });
    await manageVideo(f.scope, { action: "review-shot", storyboardId: f.boardId, shotId: f.shotId, approved: false }, () => store);
    expect((await listClips(f.scope)).find(c => c.id === clip.id)?.usable).toBe(false); await expect(readClip(f.scope, clip.id, store)).rejects.toThrow("storyboard changed");
  });
  async function higgsfield(f: Fixture, policy: "final" | "account-quote-v1" = "final") {
    const settings = { keyId: "fixture-key-id", secret: "fixture-not-real-secret", verifiedUntil: new Date(Date.now() + 86400000).toISOString(), outputHosts: ["cdn.example.com"] };
    const providerJobId = crypto.randomUUID();
    const replies: unknown[] = [{ usd: "0.06", credits: "1" }, { request_id: providerJobId, status: "queued", status_url: `https://api.higgsfield.ai/requests/${providerJobId}/status` }];
    const fetcher = vi.fn<typeof fetch>(async () => { const value = replies.shift(); if (!value) throw Error("Unexpected provider HTTP"); return Response.json(value); });
    const download = vi.fn(async () => source);
    const make = () => createHiggsfieldShotAdapter(settings, fetcher, download, policy);
    const adapter = make(); f.adapters = [adapter];
    vi.stubEnv("VIDEO_RATE_CARD_JSON", JSON.stringify([{ ...rate, provider: adapter.id, accountId: adapter.accountId, adapterVersion: adapter.version, model: "seedance-2.5-text", verifiedUntil: settings.verifiedUntil, expensePolicy: policy }]));
    await worker();
    return { providerJobId, replies, fetcher, download, make, settings };
  }
  it.each(["completed", "failed", "nsfw", "canceled"])("journals real transport identity across restart and holds unverified %s expense", async state => {
    const f = await setup(), h = await higgsfield(f), id = await accept(f);
    await runOneShotGeneration(f.adapters, () => store);
    const accepted = await row(id), saved = accepted.receipt as { preparation: string; submission: { journal: string } };
    expect(accepted).toMatchObject({ status: "POLLING", providerJobId: h.providerJobId });
    expect(JSON.parse(saved.preparation)).toMatchObject({ estimatedUsdMicros: 60000 });
    expect(JSON.parse(saved.submission.journal)).toMatchObject({ operationId: id, providerJobId: h.providerJobId });
    expect(JSON.stringify(saved)).not.toContain(h.settings.secret);
    f.adapters = [h.make()];
    h.replies.push({ request_id: h.providerJobId, status: "in_progress" }); await due(id); await runOneShotGeneration(f.adapters, () => store);
    expect((await row(id)).receipt).toEqual(saved);
    h.replies.push({ request_id: h.providerJobId, status: state, ...(state === "completed" ? { video: { url: "https://cdn.example.com/private.mp4" } } : {}) });
    await due(id); await runOneShotGeneration(f.adapters, () => store); await runOneShotGeneration(f.adapters, () => store);
    const stopped = await row(id);
    expect(stopped).toMatchObject({ status: "NEEDS_RECONCILIATION", errorCode: "SUPPLIER_EXPENSE_UNVERIFIED", supplierCostMicros: null, settledAt: null });
    expect(stopped.receipt).toMatchObject({ submission: saved.submission, preparation: saved.preparation, result: { status: "unverified", providerState: state } });
    expect(await wallet(f)).toMatchObject({ available: 90, held: 10 }); expect(objects.size).toBe(0); expect(h.download).not.toHaveBeenCalled();
    expect(h.fetcher).toHaveBeenCalledTimes(4);
    expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/text-to-video") && !String(url).includes("/estimate/"))).toHaveLength(1);
    expect(JSON.stringify(await listShotGenerations(f.scope))).not.toContain("journal");
    await reconcileShotGeneration({ generationId: id, supplierCostMicros: state === "completed" ? 60000 : 0, evidence: "Test-only verified ledger entry, not a live supplier bill", operatorId: "fixture-operator" });
    expect((await row(id)).receipt).toMatchObject({ submission: saved.submission, preparation: saved.preparation });
    expect(await wallet(f)).toMatchObject({ available: 100, held: 0 });
  });
  it.each(["brand", "permission", "execution", "configuration", "lease", "price"])("rechecks %s after read-only estimate before the submission fence", async reason => {
    const f = await setup(), h = await higgsfield(f), id = await accept(f);
    h.fetcher.mockImplementationOnce(async () => {
      if (reason === "brand") await db.business.update({ where: { id: f.scope.businessId }, data: { version: { increment: 1 } } });
      if (reason === "permission") await db.membership.update({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } }, data: { role: "VIEWER" } });
      if (reason === "execution") vi.stubEnv("PAID_EXECUTION_ENABLED", "false");
      if (reason === "configuration") vi.stubEnv("VIDEO_RATE_CARD_JSON", "[]");
      if (reason === "lease") { await db.videoGeneration.update({ where: { id }, data: { leaseUntil: new Date(0) } }); await recoverShotGenerations(); }
      return Response.json({ usd: reason === "price" ? "1" : "0.06", credits: "1" });
    });
    await runOneShotGeneration(f.adapters, () => store);
    const current = await row(id); expect(h.fetcher).toHaveBeenCalledTimes(1); expect(current.submittedAt).toBeNull(); expect(current.providerJobId).toBeNull();
    if (reason === "lease") { expect(current.status).toBe("QUEUED"); expect((await wallet(f)).held).toBe(10); }
    else { expect(current.status).toBe("FAILED"); expect(await wallet(f)).toMatchObject({ available: 100, held: 0 }); }
  });
  it.each(["missing", "signature", "operation", "prompt", "credentials"])("never polls a %s or rebound journal", async reason => {
    const f = await setup(), h = await higgsfield(f), id = await accept(f); await runOneShotGeneration(f.adapters, () => store);
    const current = await row(id), saved = current.receipt as { preparation: string; submission: { journal?: string } };
    if (reason === "missing") delete saved.submission.journal;
    if (reason === "signature" || reason === "operation") { const journal = JSON.parse(saved.submission.journal!); journal[reason === "signature" ? "signature" : "operationId"] = reason === "signature" ? "0".repeat(64) : "other-operation"; saved.submission.journal = JSON.stringify(journal); }
    if (reason === "prompt") await db.videoGeneration.update({ where: { id }, data: { prompt: "Changed after acceptance" } });
    if (reason === "credentials") f.adapters = [createHiggsfieldShotAdapter({ ...h.settings, secret: "different-private-credential" }, h.fetcher, h.download)];
    await db.videoGeneration.update({ where: { id }, data: { receipt: saved, nextPollAt: new Date(0) } });
    await runOneShotGeneration(f.adapters, () => store);
    expect((await row(id)).status).toBe("NEEDS_RECONCILIATION"); expect(h.fetcher).toHaveBeenCalledTimes(2); expect((await wallet(f)).held).toBe(10);
  });
  it("preserves the estimate but never resubmits after an ambiguous real transport submission", async () => {
    const f = await setup(), h = await higgsfield(f), id = await accept(f);
    h.fetcher.mockImplementationOnce(async () => Response.json(h.replies.shift())).mockRejectedValueOnce(Error("lost acknowledgement"));
    await runOneShotGeneration(f.adapters, () => store); await recoverShotGenerations(); await runOneShotGeneration(f.adapters, () => store);
    const current = await row(id); expect(current).toMatchObject({ status: "NEEDS_RECONCILIATION", providerJobId: null }); expect(current.receipt).toHaveProperty("preparation");
    expect(h.fetcher).toHaveBeenCalledTimes(2); expect((await wallet(f)).held).toBe(10);
  });
  async function provisional() {
    const f = await setup(), h = await higgsfield(f, "account-quote-v1"), id = await accept(f);
    await runOneShotGeneration(f.adapters, () => store);
    h.replies.push({ request_id: h.providerJobId, status: "completed", video: { url: "https://cdn.example.com/output.mp4" } });
    f.adapters = [h.make()]; await due(id); await runOneShotGeneration(f.adapters, () => store);
    return { f, h, id };
  }
  it.each([0, 40000, 60000, 150000])("delivers account-quoted footage once then reconciles final expense %s without customer repricing", async actual => {
    const { f, h, id } = await provisional();
    expect(await row(id)).toMatchObject({ status: "INGESTING", supplierEstimateMicros: 60000, expenseBasis: "ACCOUNT_QUOTE_V1", supplierCostMicros: null, supplierReconciledAt: null });
    expect((await wallet(f)).held).toBe(10); expect(h.download).toHaveBeenCalledTimes(1);
    await runOneClip(async () => processed, () => store); await runOneClip(async () => processed, () => store);
    const ready = await row(id); expect(ready).toMatchObject({ status: "READY", supplierCostMicros: null, output: { status: "READY", approvedBy: null } });
    expect(await wallet(f)).toMatchObject({ available: 94, held: 0 });
    await reviewClip(f.scope, ready.output!.id, { action: "approve", watched: true });
    const input = { generationId: id, supplierCostMicros: actual, evidence: "Independent test-only invoice evidence", operatorId: "test-operator" };
    await Promise.all([reconcileShotGeneration(input), reconcileShotGeneration(input)]);
    const reconciled = await row(id);
    expect(reconciled).toMatchObject({ status: "READY", supplierCostMicros: actual, supplierEstimateMicros: 60000, expenseBasis: "ACCOUNT_QUOTE_V1", settledAt: ready.settledAt, output: { approvedBy: f.scope.actorId } });
    expect(reconciled.supplierReconciledAt).toBeInstanceOf(Date);
    expect((await db.supplierAuthorization.findUniqueOrThrow({ where: { key: id } })).ceilingMicros).toBe(Math.max(100000, actual));
    expect(await wallet(f)).toMatchObject({ available: 94, held: 0 });
    expect(await db.auditEvent.count({ where: { businessId: f.scope.businessId, action: "SHOT_EXPENSE_RECONCILED" } })).toBe(1);
    expect(await readClip(f.scope, ready.output!.id, store)).toEqual(processed.bytes);
    for (const changed of [{ ...input, supplierCostMicros: actual + 1 }, { ...input, evidence: "Changed invoice evidence" }, { ...input, operatorId: "another-operator" }]) await expect(reconcileShotGeneration(changed)).rejects.toThrow("replay changed");
    expect(h.fetcher).toHaveBeenCalledTimes(3);
    const publicJobs = JSON.stringify(await listShotGenerations(f.scope));
    for (const privateField of ["supplierEstimateMicros", "supplierCostMicros", "expenseBasis", "receipt", "operatorId", "evidence"]) expect(publicJobs).not.toContain(privateField);
  });
  it.each(["failed", "nsfw", "canceled"])("releases customer credits for provisional %s without claiming a final zero invoice", async status => {
    const f = await setup(), h = await higgsfield(f, "account-quote-v1"), id = await accept(f); await runOneShotGeneration(f.adapters, () => store);
    h.replies.push({ request_id: h.providerJobId, status }); await due(id); await runOneShotGeneration(f.adapters, () => store);
    expect(await row(id)).toMatchObject({ status: "FAILED", supplierEstimateMicros: 0, supplierCostMicros: null, expenseBasis: "ACCOUNT_QUOTE_V1", output: { status: "FAILED" } });
    expect(await wallet(f)).toMatchObject({ available: 100, held: 0 }); expect(h.download).not.toHaveBeenCalled();
    await reconcileShotGeneration({ generationId: id, supplierCostMicros: 0, evidence: "Independent refund ledger fixture", operatorId: "test-operator" });
    expect(await row(id)).toMatchObject({ status: "FAILED", supplierCostMicros: 0, supplierEstimateMicros: 0 });
  });
  it.each(["decoder", "duration", "context", "permission", "storage", "lease"])("refunds provisional footage after %s failure but preserves supplier exposure", async reason => {
    const { f, id } = await provisional(), current = await row(id);
    if (reason === "context") await db.videoStoryboard.update({ where: { id: f.boardId }, data: { status: "DRAFT" } });
    if (reason === "permission") await db.membership.update({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } }, data: { role: "VIEWER" } });
    if (reason === "lease") { await db.videoClip.update({ where: { id: current.output!.id }, data: { status: "RUNNING", leaseUntil: new Date(0) } }); await recoverClipLeases(); }
    else await runOneClip(async () => { if (reason === "decoder") throw Error("bad decoder"); return { ...processed, durationMs: reason === "duration" ? 4000 : 5000 }; }, () => reason === "storage" ? { ...store, put: async () => { throw Error("storage failure"); } } : store);
    expect(await row(id)).toMatchObject({ status: "FAILED", supplierEstimateMicros: 60000, supplierCostMicros: null });
    expect(await wallet(f)).toMatchObject({ available: 100, held: 0 });
    await reconcileShotGeneration({ generationId: id, supplierCostMicros: 60000, evidence: "Independent failed output invoice fixture", operatorId: "test-operator" });
    expect(await wallet(f)).toMatchObject({ available: 100, held: 0 });
  });
  it("refuses provisional reconciliation before normalization has settled customer credits", async () => {
    const { f, id } = await provisional();
    await expect(reconcileShotGeneration({ generationId: id, supplierCostMicros: 60000, evidence: "Independent premature invoice fixture", operatorId: "test-operator" })).rejects.toThrow("Only uncertain");
    expect((await wallet(f)).held).toBe(10); expect((await row(id)).supplierCostMicros).toBeNull();
  });
  it.each(["READY", "FAILED"])("counts older provisional %s exposure until independent reconciliation and through reconciliation day", async status => {
    const { f, id } = await provisional();
    await runOneClip(async () => { if (status === "FAILED") throw Error("bad media"); return processed; }, () => store);
    const old = new Date(Date.now() - 3 * 86400000);
    await db.supplierAuthorization.update({ where: { key: id }, data: { createdAt: old } });
    await db.videoGeneration.update({ where: { id }, data: { acceptedAt: old, submittedAt: old, settledAt: old } });
    vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "100000");
    const key = crypto.randomUUID(); extras.push(key);
    await expect(db.$transaction(tx => authorizeSupplier(tx, key, 1))).rejects.toThrow("supplier-spend limit");
    await reconcileShotGeneration({ generationId: id, supplierCostMicros: 60000, evidence: "Independent dated invoice fixture", operatorId: "test-operator" });
    await expect(db.$transaction(tx => authorizeSupplier(tx, key, 1))).rejects.toThrow("supplier-spend limit");
    await db.videoGeneration.update({ where: { id }, data: { supplierReconciledAt: old } });
    await db.$transaction(tx => authorizeSupplier(tx, key, 1));
    expect((await wallet(f)).held).toBe(0);
  });
  it.each(["basis", "amount", "negative", "ceiling", "reconciled"])("database rejects malformed provisional %s independently of application code", async reason => {
    const f = await setup(), id = await quote(f);
    const invalid = reason === "basis" ? { supplierEstimateMicros: 1 } : reason === "amount" ? { expenseBasis: "ACCOUNT_QUOTE_V1" } : reason === "reconciled" ? { supplierReconciledAt: new Date() } : { expenseBasis: "ACCOUNT_QUOTE_V1", supplierEstimateMicros: reason === "negative" ? -1 : 100001 };
    await expect(db.videoGeneration.update({ where: { id }, data: invalid })).rejects.toThrow();
  });
  it("refuses a provisional result from a final-expense route without releasing a hold or storing media", async () => {
    const f = await setup(), id = await accept(f); await runOneShotGeneration(f.adapters, () => store); await due(id);
    f.poll.mockImplementationOnce(async x => ({ requestId: x.requestId, providerJobId: x.providerJobId, accountId: rate.accountId, model: rate.model, status: "provisional-succeeded", estimatedCostMicros: 60000, bytes: source }));
    await runOneShotGeneration(f.adapters, () => store);
    expect(await row(id)).toMatchObject({ status: "NEEDS_RECONCILIATION", supplierEstimateMicros: null }); expect((await wallet(f)).held).toBe(10); expect(objects.size).toBe(0);
  });
  it.skipIf(!process.env.TEST_FFMPEG_PATH || !process.env.TEST_FFPROBE_PATH)("assembles a genuine downloaded shot through real normalization, reviewed motion export and unchanged invoice reconciliation", async () => {
    const exec = promisify(execFile), dir = await mkdtemp(join(tmpdir(), "generated-delivery-fixture-"));
    try {
      vi.stubEnv("FFMPEG_PATH", process.env.TEST_FFMPEG_PATH!); vi.stubEnv("FFPROBE_PATH", process.env.TEST_FFPROBE_PATH!);
      await exec(process.env.TEST_FFMPEG_PATH!, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "5", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", join(dir, "source.mp4")], { timeout: 10000 });
      const f = await setup(), h = await higgsfield(f, "account-quote-v1"), id = await accept(f);
      h.download.mockResolvedValue(await readFile(join(dir, "source.mp4")));
      await runOneShotGeneration(f.adapters, () => store);
      h.replies.push({ request_id: h.providerJobId, status: "completed", video: { url: "https://cdn.example.com/output.mp4" } });
      await due(id); await runOneShotGeneration([h.make()], () => store); await runOneClip(undefined, () => store);
      const ready = await row(id); expect(ready).toMatchObject({ status: "READY", supplierCostMicros: null, output: { status: "READY", durationMs: 5000 } });
      await reviewClip(f.scope, ready.output!.id, { action: "approve", watched: true });
      const doc = storyboardDocument.parse((await db.videoStoryboard.findUniqueOrThrow({ where: { id: f.boardId } })).document);
      doc.shots = [{ ...doc.shots[0], clip: { id: ready.output!.id, sha256: ready.output!.sha256 } }];
      const next = (await manageVideo(f.scope, { action: "save", storyboardId: f.boardId, document: doc }, () => store)).storyboardId!;
      await manageVideo(f.scope, { action: "review-shot", storyboardId: next, shotId: doc.shots[0].id, approved: true }, () => store);
      await manageVideo(f.scope, { action: "approve-storyboard", storyboardId: next }, () => store);
      const renderId = (await manageVideo(f.scope, { action: "render", storyboardId: next }, () => store)).renderId!;
      await runOneMotion(undefined, () => store);
      expect((await db.motionRender.findUniqueOrThrow({ where: { id: renderId } })).status).toBe("READY");
      await expect(readMotion(f.scope, renderId, true, store)).rejects.toThrow("awaiting approval");
      await manageVideo(f.scope, { action: "approve-render", renderId, continuityReviewed: true }, () => store);
      const output = await readMotion(f.scope, renderId, true, store);
      await writeFile(join(dir, "final.mp4"), output.bytes);
      const probe = JSON.parse((await exec(process.env.TEST_FFPROBE_PATH!, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", join(dir, "final.mp4")], { timeout: 10000 })).stdout);
      expect(probe.streams).toEqual([{ codec_name: "h264", codec_type: "video", width: 720, height: 1280 }]); expect(Number(probe.format.duration)).toBe(5);
      await reconcileShotGeneration({ generationId: id, supplierCostMicros: 80000, evidence: "Independent synthetic invoice, no live provider calls", operatorId: "test-operator" });
      expect((await readMotion(f.scope, renderId, true, store)).bytes).toEqual(output.bytes);
      expect(await wallet(f)).toMatchObject({ available: 94, held: 0 }); expect(h.fetcher).toHaveBeenCalledTimes(3);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60000);
});
