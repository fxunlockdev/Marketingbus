import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../src/lib/db";
import { savePlanning, createDuePlan, runOneWeeklyDraft, cancelWeeklyCycle, readPlanning } from "../src/lib/workflows/planning";
import { runOneWeeklyVideo } from "../src/lib/workflows/weekly-videos";
import { manageVideo, readMotion } from "../src/lib/video/service";
import { manageShotGeneration } from "../src/lib/video/generation-service";
import { runOneShotGeneration } from "../src/lib/video/generation-worker";
import { runOneClip, reviewClip } from "../src/lib/video/clips";
import { runOneMotion } from "../src/lib/video/worker";
import { storyboardDocument } from "../src/lib/video/document";
import { WORKER_RUNTIME, workerConfigurationHash } from "../src/lib/production/readiness";
import type { ShotAdapter } from "../src/lib/video/generation-contracts";
import type { AssetStore } from "../src/lib/assets/storage";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local test DB required");
suite("weekly mixed-media hand-offs", () => {
  const orgs: string[] = [], users: string[] = [], workerId = crypto.randomUUID(), objects = new Map<string, Buffer>();
  const store: AssetStore = { put: async (key, bytes) => { objects.set(key, Buffer.from(bytes)); }, get: async key => { const b = objects.get(key); if (!b) throw Error("missing"); return b; }, remove: async key => { objects.delete(key); } };
  const policy = { enabled: true, mode: "DRAFTS", videosAfterApproval: true, videoItems: 1, maxItems: 1, creditsPerWeek: 100, weekday: 1, hourUTC: 9, version: 0 };
  const rate = { provider: "fixture", accountId: "test-account", adapterVersion: "v1", model: "test-video", durationMs: 5000, ceilingMicros: 100000, verifiedUntil: "2099-01-01T00:00:00Z" };
  const source = Buffer.from("000000186674797069736f6d0000020069736f6d6d703432", "hex");
  const submit = vi.fn(async (input: Parameters<ShotAdapter["submit"]>[0]) => ({ requestId: input.requestId, providerJobId: `job-${input.requestId}`, accountId: rate.accountId }));
  const poll = vi.fn(async (input: Parameters<ShotAdapter["poll"]>[0]): Promise<unknown> => ({ requestId: input.requestId, providerJobId: input.providerJobId, accountId: rate.accountId, model: rate.model, status: "succeeded", costMicros: 60000, bytes: source }));
  const adapters: ShotAdapter[] = [{ id: rate.provider, version: rate.adapterVersion, accountId: rate.accountId, submit, poll }];
  beforeEach(async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-no-network"); vi.stubEnv("PAID_EXECUTION_ENABLED", "true"); vi.stubEnv("MOTION_RENDERING_ENABLED", "true"); vi.stubEnv("MOTION_RENDER_DAILY_LIMIT", "100");
    vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "100000000"); vi.stubEnv("TOTAL_SUPPLIER_BUDGET_MICROS", "1000000000");
    vi.stubEnv("REASONING_RATE_CARD_JSON", JSON.stringify([{ provider: "openai", model: "FIXTURE", lane: "creative", inputUsdPerMillion: 0.01, outputUsdPerMillion: 0.01, verifiedUntil: "2099-01-01T00:00:00Z" }]));
    vi.stubEnv("VIDEO_RATE_CARD_JSON", JSON.stringify([rate]));
    await db.workerHeartbeat.upsert({ where: { id: workerId }, create: { id: workerId, runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), executionEnabled: true, motionReady: true }, update: { runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), executionEnabled: true, motionReady: true, lastSeenAt: new Date() } });
    submit.mockClear(); poll.mockClear();
  });
  afterEach(async () => {
    const where = { organizationId: { in: orgs } };
    const [jobs, quotes, clips, renders] = await Promise.all([db.videoGeneration.findMany({ where }), db.generationQuote.findMany({ where }), db.videoClip.findMany({ where }), db.motionRender.findMany({ where })]);
    await db.motionAuthorization.deleteMany({ where: { key: { in: [...clips, ...renders].map(r => r.id) } } });
    await db.supplierAuthorization.deleteMany({ where: { key: { in: [...jobs, ...quotes].map(r => r.id) } } });
    await db.videoClip.deleteMany({ where }); await db.videoGeneration.deleteMany({ where }); await db.motionRender.deleteMany({ where });
    await db.videoStoryboard.deleteMany({ where }); await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.user.deleteMany({ where: { id: { in: users } } }); orgs.length = users.length = 0; objects.clear(); vi.unstubAllEnvs();
  });
  afterAll(async () => { await db.workerHeartbeat.deleteMany({ where: { id: workerId } }); await db.$disconnect(); });
  async function setup(overrides = {}) {
    const user = await db.user.create({ data: { email: `${crypto.randomUUID()}@example.test`, name: "Weekly video fixture", passwordHash: "not-a-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "WEEKLY VIDEO FIXTURE", wallet: { create: { available: 1000 } }, memberships: { create: { userId: user.id, role: "OWNER" } } } }); orgs.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Design studio", offering: "Design consultations", audience: "Homeowners", goal: "Book consultations", channels: ["Instagram"], confirmedAt: new Date() } });
    const scope = { businessId: business.id, organizationId: org.id, actorId: user.id };
    await savePlanning(scope, { ...policy, ...overrides });
    await db.weeklyPolicy.update({ where: { businessId: business.id }, data: { nextRunAt: new Date(0) } }); await createDuePlan();
    const cycle = await db.weeklyCycle.findFirstOrThrow({ where: { businessId: business.id }, include: { tasks: true } });
    return { scope, cycle, task: cycle.tasks[0], cancel: { action: "cancelCycle", cycleId: cycle.id, policyVersion: cycle.policyVersion } };
  }
  type Fixture = Awaited<ReturnType<typeof setup>>;
  const run = () => runOneWeeklyVideo({ adapters, storage: () => store });
  const tick = async (f: Fixture) => { await db.weeklyCycle.update({ where: { id: f.cycle.id }, data: { nextVideoAt: null } }); await run(); };
  const task = (f: Fixture) => db.weeklyTask.findUniqueOrThrow({ where: { id: f.task.id }, include: { shots: true, cycle: true } });
  async function copy(f: Fixture, status = "APPROVED") {
    for (let i = 0; i <= f.cycle.tasks.length; i++) await runOneWeeklyDraft();
    await db.job.updateMany({ where: { businessId: f.scope.businessId }, data: { status: "COMPLETED" } });
    return db.creativeRevision.create({ data: { itemId: f.task.itemId, organizationId: f.scope.organizationId, authorId: f.scope.actorId, version: 1, status,
      content: { headline: "A considered home", caption: "Explore design consultations.", cta: "Meet us", visualDirection: "Warm architectural light", rationale: "A clear introduction", evidenceUsed: [] } } });
  }
  async function approve(f: Fixture, id: string) {
    const board = await db.videoStoryboard.findUniqueOrThrow({ where: { id } });
    for (const shot of storyboardDocument.parse(board.document).shots) await manageVideo(f.scope, { action: "review-shot", storyboardId: id, shotId: shot.id, approved: true }, () => store);
    await manageVideo(f.scope, { action: "approve-storyboard", storyboardId: id }, () => store);
  }
  async function board(f: Fixture) { await copy(f); await tick(f); const id = (await task(f)).storyboardId!; await approve(f, id); return id; }
  it("preserves legacy YouTube planning without acquiring new copy-spend consent", async () => {
    const f = await setup({ videosAfterApproval: false });
    await db.weeklyCycle.update({ where: { id: f.cycle.id }, data: { periodKey: "legacy-fixture-week", status: "CANCELLED" } });
    await db.business.update({ where: { id: f.scope.businessId }, data: { channels: ["YouTube"] } });
    await db.weeklyPolicy.update({ where: { businessId: f.scope.businessId }, data: { videoItems: null, nextRunAt: new Date(0) } });
    await createDuePlan();
    const cycle = await db.weeklyCycle.findFirstOrThrow({ where: { businessId: f.scope.businessId, id: { not: f.cycle.id } }, include: { tasks: true } });
    expect((await db.productionItem.findFirstOrThrow({ where: { planId: cycle.planId } })).format).toBe("motion");
    expect(cycle.tasks[0]).toMatchObject({ status: "SKIPPED", errorCode: "MEDIA_REQUIRES_DIRECTION" });
    const execute = vi.fn(); await runOneWeeklyDraft(execute); expect(execute).not.toHaveBeenCalled();
  });
  it("saves a real static/video mix without generating in planning-only mode", async () => {
    const f = await setup({ mode: "PLAN", videosAfterApproval: false, maxItems: 3 });
    const items = await db.productionItem.findMany({ where: { planId: f.cycle.planId } });
    expect(items.filter(i => i.format === "motion")).toHaveLength(1); expect(items.filter(i => i.format === "static")).toHaveLength(2);
    expect(f.cycle.videoStatus).toBe("NONE"); expect(await run()).toBe(false);
    await expect(savePlanning(f.scope, { ...policy, version: 1, videoItems: 2 })).rejects.toThrow("cannot exceed");
    await expect(savePlanning(f.scope, { ...policy, version: 1, mode: "PLAN" })).rejects.toThrow("requires draft mode");
    await expect(db.weeklyPolicy.update({ where: { businessId: f.scope.businessId }, data: { videosAfterApproval: true } })).rejects.toThrow();
  });
  it("waits for copy approval, drafts one storyboard concurrently, then waits for exact scene review", async () => {
    const f = await setup(), revision = await copy(f, "READY"); await run();
    expect((await task(f)).storyboardId).toBeNull(); expect(await run()).toBe(false);
    await db.creativeRevision.update({ where: { id: revision.id }, data: { status: "APPROVED" } });
    await db.weeklyCycle.update({ where: { id: f.cycle.id }, data: { nextVideoAt: null } }); await Promise.all([run(), run()]);
    const current = await task(f); expect(current.videoStatus).toBe("STORYBOARD");
    const row = await db.videoStoryboard.findUniqueOrThrow({ where: { id: current.storyboardId! } });
    expect(row.status).toBe("DRAFT"); expect(storyboardDocument.parse(row.document).shots[0].caption).toBe("A considered home");
    await tick(f); expect(await db.videoGeneration.count({ where: { businessId: f.scope.businessId } })).toBe(0);
    expect(await db.videoStoryboard.count({ where: { businessId: f.scope.businessId } })).toBe(1);
    const quote = await db.generationQuote.findUniqueOrThrow({ where: { id: current.quoteId! } });
    expect(JSON.stringify(quote.request)).toContain("Video concept and publishable caption");
  });
  it("reserves shared credits once, reports held footage separately and never auto-publishes", async () => {
    const f = await setup(); await board(f); await tick(f); await tick(f);
    const current = await task(f); expect(current.shots).toHaveLength(1); expect(current.cycle.creditsAuthorized).toBe(11);
    const read = (await readPlanning(f.scope)).cycles[0]; expect(read.tasks[0]).toMatchObject({ videoStatus: "PRODUCING", videoHeldCredits: 10, videoJobStatuses: ["QUEUED"] });
    expect(JSON.stringify(read)).not.toMatch(/configurationHash|generationId|prompt|actorId|objectKey/);
    expect(submit).not.toHaveBeenCalled(); expect(await db.socialPublication.count({ where: { businessId: f.scope.businessId } })).toBe(0);
  });
  it("rolls back shared over-budget acceptance, cancels its offer and never requotes", async () => {
    const f = await setup({ creditsPerWeek: 1 }); await board(f); await tick(f);
    const current = await task(f); expect(current.cycle).toMatchObject({ videoStatus: "BLOCKED", creditsAuthorized: 1 }); expect(current.videoStatus).toBe("STOPPED");
    expect(await db.videoGeneration.findFirstOrThrow({ where: { businessId: f.scope.businessId } })).toMatchObject({ status: "CANCELLED", reservationId: null });
    expect(await run()).toBe(false); expect(submit).not.toHaveBeenCalled();
  });
  it("cancellation between quote and acceptance defeats spending without resurrecting the run", async () => {
    const f = await setup(); await board(f); await db.weeklyCycle.update({ where: { id: f.cycle.id }, data: { nextVideoAt: null } });
    await runOneWeeklyVideo({ adapters, storage: () => store, shot: async (...args) => { const result = await manageShotGeneration(...args); if (result.generationId) await cancelWeeklyCycle(f.scope, f.cancel); return result; } });
    expect((await task(f)).cycle).toMatchObject({ status: "CANCELLED", videoStatus: "CANCELLED", creditsAuthorized: 1 });
    expect(await db.videoGeneration.findFirstOrThrow({ where: { businessId: f.scope.businessId } })).toMatchObject({ status: "CANCELLED", acceptedAt: null });
  });
  it.each(["brand", "role", "week", "policy"])("stops further work on %s drift without releasing accepted holds", async reason => {
    const f = await setup(); await board(f); await tick(f);
    const before = await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } });
    if (reason === "brand") await db.business.update({ where: { id: f.scope.businessId }, data: { version: 2 } });
    if (reason === "role") await db.membership.update({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } }, data: { role: "VIEWER" } });
    if (reason === "week") await db.weeklyCycle.update({ where: { id: f.cycle.id }, data: { periodKey: "2001-01-01" } });
    if (reason === "policy") await savePlanning(f.scope, { ...policy, enabled: false, version: 1 });
    await tick(f); expect((await task(f)).cycle.videoStatus).toBe("CANCELLED");
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } })).toEqual(before);
    expect(await db.videoGeneration.findFirstOrThrow({ where: { businessId: f.scope.businessId } })).toMatchObject({ status: "QUEUED" });
  });
  it("blocks late approval revocation and rejects manual acceptance that bypasses the weekly ceiling", async () => {
    const f = await setup(), boardId = await board(f); await db.weeklyCycle.update({ where: { id: f.cycle.id }, data: { nextVideoAt: null } });
    await runOneWeeklyVideo({ adapters, storage: () => store, shot: async (...args) => {
      const result = await manageShotGeneration(...args);
      if (result.generationId) {
        await expect(manageShotGeneration(f.scope, { action: "accept", generationId: result.generationId, rightsConfirmed: true }, adapters, () => store)).rejects.toThrow("recurring authorization");
        await db.videoStoryboard.update({ where: { id: boardId }, data: { status: "DRAFT" } });
      }
      return result;
    } });
    expect((await task(f)).cycle).toMatchObject({ videoStatus: "BLOCKED", creditsAuthorized: 1 });
  });
  it("preserves a manual storyboard instead of taking it over", async () => {
    const f = await setup(); await copy(f); const manual = await manageVideo(f.scope, { action: "create", itemId: f.task.itemId }, () => store);
    await tick(f); expect((await task(f)).videoStatus).toBe("SKIPPED"); expect((await task(f)).storyboardId).toBeNull();
    expect(await db.videoStoryboard.findUniqueOrThrow({ where: { id: manual.storyboardId! } })).toMatchObject({ status: "DRAFT" });
  });
  it("stops after a paid scene is superseded rather than interpreting it against a different storyboard", async () => {
    const f = await setup(), id = await board(f); await tick(f);
    const doc = storyboardDocument.parse((await db.videoStoryboard.findUniqueOrThrow({ where: { id } })).document);
    doc.shots[0].caption = "A fresh perspective";
    await manageVideo(f.scope, { action: "save", storyboardId: id, document: doc }, () => store); await tick(f);
    expect((await task(f)).cycle).toMatchObject({ videoStatus: "BLOCKED", creditsAuthorized: 11 });
    expect(await db.videoGeneration.count({ where: { businessId: f.scope.businessId } })).toBe(1);
  });
  it("does not let a waiting business monopolize the lane or expose another tenant's runs", async () => {
    const waiting = await setup(); await copy(waiting, "READY"); const ready = await setup(); await copy(ready);
    await run(); await run();
    expect((await task(waiting)).storyboardId).toBeNull(); expect((await task(ready)).storyboardId).not.toBeNull();
    await expect(readPlanning({ ...ready.scope, actorId: waiting.scope.actorId })).rejects.toThrow("not found");
    await expect(cancelWeeklyCycle(waiting.scope, ready.cancel)).rejects.toThrow("not found");
  });
  it("does not attach a storyboard after cancellation between selection and creation", async () => {
    const f = await setup(); await copy(f);
    await runOneWeeklyVideo({ adapters, storage: () => store, video: async (...args) => { await cancelWeeklyCycle(f.scope, f.cancel); return manageVideo(...args); } });
    expect((await task(f)).cycle.videoStatus).toBe("CANCELLED"); expect((await task(f)).storyboardId).toBeNull();
    expect(await db.videoStoryboard.count({ where: { businessId: f.scope.businessId } })).toBe(0);
  });
  it("never recreates an uncertain shot and retains its held credits", async () => {
    const f = await setup(); await board(f); await tick(f);
    await db.videoGeneration.update({ where: { id: (await task(f)).shots[0].generationId }, data: { status: "NEEDS_RECONCILIATION", submittedAt: new Date() } });
    await tick(f); expect((await task(f)).cycle.videoStatus).toBe("BLOCKED");
    expect((await readPlanning(f.scope)).cycles[0].tasks[0]).toMatchObject({ videoHeldCredits: 10, videoJobStatuses: ["NEEDS_RECONCILIATION"] });
    expect(await run()).toBe(false); expect(submit).not.toHaveBeenCalled();
  });
  it.skipIf(!process.env.TEST_FFMPEG_PATH || !process.env.TEST_FFPROBE_PATH)("delivers approved generated footage through automatic assembly and a real playable reviewed export", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weekly-video-fixture-"));
    try {
      vi.stubEnv("FFMPEG_PATH", process.env.TEST_FFMPEG_PATH!); vi.stubEnv("FFPROBE_PATH", process.env.TEST_FFPROBE_PATH!);
      await db.workerHeartbeat.update({ where: { id: workerId }, data: { configurationHash: workerConfigurationHash(), lastSeenAt: new Date() } });
      await promisify(execFile)(process.env.TEST_FFMPEG_PATH!, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24", "-t", "5", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(dir, "source.mp4")], { timeout: 10000 });
      const bytes = await readFile(join(dir, "source.mp4")), f = await setup(); await copy(f); await tick(f);
      const original = (await task(f)).storyboardId!, doc = storyboardDocument.parse((await db.videoStoryboard.findUniqueOrThrow({ where: { id: original } })).document);
      doc.shots = [doc.shots[0]]; const edited = (await manageVideo(f.scope, { action: "save", storyboardId: original, document: doc }, () => store)).storyboardId!;
      await approve(f, edited); await tick(f);
      const id = (await task(f)).shots[0].generationId;
      poll.mockImplementationOnce(async input => ({ requestId: input.requestId, providerJobId: input.providerJobId, accountId: rate.accountId, model: rate.model, status: "succeeded", costMicros: 60000, bytes }));
      await runOneShotGeneration(adapters, () => store); await db.videoGeneration.update({ where: { id }, data: { nextPollAt: new Date(0) } });
      await runOneShotGeneration(adapters, () => store); await runOneClip(undefined, () => store);
      const generated = await db.videoGeneration.findUniqueOrThrow({ where: { id }, include: { output: true } }); expect(generated.status).toBe("READY");
      await tick(f); expect((await task(f)).storyboardId).toBe(edited);
      await reviewClip(f.scope, generated.output!.id, { action: "approve", watched: true }); await tick(f);
      const assembled = (await task(f)).storyboardId!; expect(assembled).not.toBe(edited); expect((await task(f)).videoStatus).toBe("REVIEW");
      expect(await db.videoStoryboard.findUniqueOrThrow({ where: { id: assembled } })).toMatchObject({ status: "DRAFT", shotApprovals: [] });
      await tick(f); expect((await task(f)).renderId).toBeNull(); await approve(f, assembled); await tick(f);
      const renderId = (await task(f)).renderId!; await runOneMotion(undefined, () => store);
      expect(await db.motionRender.findUniqueOrThrow({ where: { id: renderId } })).toMatchObject({ status: "READY", durationMs: 5000 });
      await expect(readMotion(f.scope, renderId, true, store)).rejects.toThrow("awaiting approval");
      await manageVideo(f.scope, { action: "approve-render", renderId, continuityReviewed: true }, () => store);
      expect((await readMotion(f.scope, renderId, true, store)).bytes.length).toBeGreaterThan(1000);
      await tick(f); expect((await task(f)).cycle).toMatchObject({ videoStatus: "COMPLETE", creditsAuthorized: 11 });
      expect(submit).toHaveBeenCalledTimes(1); expect(await db.socialPublication.count({ where: { businessId: f.scope.businessId } })).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60000);
});
