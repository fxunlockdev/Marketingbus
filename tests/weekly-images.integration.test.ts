import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { db } from "../src/lib/db";
import { savePlanning, createDuePlan, runOneWeeklyDraft, cancelWeeklyCycle, readPlanning } from "../src/lib/workflows/planning";
import { runOneWeeklyImage } from "../src/lib/workflows/weekly-images";
import { manageImage } from "../src/lib/images/service";
import { runOneImage } from "../src/lib/images/worker";
import { heartbeat } from "../src/lib/production/readiness";
import type { AssetStore } from "../src/lib/assets/storage";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local fixture database required");
suite("approval-gated weekly imagery", () => {
  const orgs: string[] = [], users: string[] = [], workerId = crypto.randomUUID(), objects = new Map<string, Buffer>();
  const store: AssetStore = { put: async (key, bytes) => { objects.set(key, Buffer.from(bytes)); }, get: async key => { const bytes = objects.get(key); if (!bytes) throw Error("missing"); return bytes; }, remove: async key => { objects.delete(key); } };
  const policy = { enabled: true, mode: "DRAFTS", imagesAfterApproval: true, maxItems: 1, creditsPerWeek: 100, weekday: 1, hourUTC: 9, version: 0 };
  beforeEach(async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-no-network"); vi.stubEnv("GEMINI_API_KEY", "fixture-no-network"); vi.stubEnv("PAID_EXECUTION_ENABLED", "true");
    vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "100000000"); vi.stubEnv("TOTAL_SUPPLIER_BUDGET_MICROS", "1000000000");
    vi.stubEnv("REASONING_RATE_CARD_JSON", JSON.stringify([{ provider: "openai", model: "FIXTURE", lane: "creative", inputUsdPerMillion: 0.01, outputUsdPerMillion: 0.01, verifiedUntil: "2099-01-01T00:00:00Z" }]));
    vi.stubEnv("IMAGE_RATE_CARD_JSON", JSON.stringify([{ model: "gemini-fixture", lane: "creative", inputUsdPerMillion: 2, outputUsdPerMillion: 8, maxOutputTokens: 4096, verifiedUntil: "2099-01-01T00:00:00Z" }]));
    await heartbeat(workerId);
  });
  afterEach(async () => {
    await db.weeklyCycle.updateMany({ where: { organizationId: { in: orgs } }, data: { status: "CANCELLED", mediaStatus: "CANCELLED", mediaLeaseUntil: null, leaseUntil: null } });
    await db.imageGeneration.updateMany({ where: { organizationId: { in: orgs }, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", leaseUntil: null } });
  });
  afterAll(async () => {
    const images = await db.imageGeneration.findMany({ where: { organizationId: { in: orgs } } });
    const quotes = await db.generationQuote.findMany({ where: { organizationId: { in: orgs } } });
    await db.supplierAuthorization.deleteMany({ where: { key: { in: [...images, ...quotes].map(r => r.id) } } });
    await db.brandAsset.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.imageGeneration.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.user.deleteMany({ where: { id: { in: users } } });
    await db.workerHeartbeat.deleteMany({ where: { id: workerId } }); vi.unstubAllEnvs(); await db.$disconnect();
  });
  async function setup(overrides = {}) {
    const user = await db.user.create({ data: { email: `${crypto.randomUUID()}@example.test`, name: "Weekly image fixture", passwordHash: "not-a-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "WEEKLY IMAGE FIXTURE", wallet: { create: { available: 1000 } }, memberships: { create: { userId: user.id, role: "OWNER" } } } }); orgs.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Design studio", offering: "Design consultations", audience: "Homeowners", goal: "Book consultations", channels: ["Facebook"], confirmedAt: new Date() } });
    const scope = { businessId: business.id, organizationId: org.id, actorId: user.id };
    await savePlanning(scope, { ...policy, ...overrides });
    await db.weeklyPolicy.update({ where: { businessId: business.id }, data: { nextRunAt: new Date(Date.now() - 1000) } }); await createDuePlan();
    const cycle = await db.weeklyCycle.findFirstOrThrow({ where: { businessId: business.id }, include: { tasks: { orderBy: { id: "asc" } } } });
    return { scope, cycle, task: cycle.tasks[0], cancel: { action: "cancelCycle", cycleId: cycle.id, policyVersion: cycle.policyVersion } };
  }
  type Fixture = Awaited<ReturnType<typeof setup>>;
  async function completeCopy(f: Fixture, status = "APPROVED") {
    await runOneWeeklyDraft(); await runOneWeeklyDraft();
    // Synthetic completed copy, no external model call. Preserve its real quote/hold linkage.
    await db.job.updateMany({ where: { businessId: f.scope.businessId }, data: { status: "COMPLETED" } });
    return db.creativeRevision.create({ data: { itemId: f.task.itemId, organizationId: f.scope.organizationId, authorId: f.scope.actorId, version: 1, status,
      content: { headline: "A considered home", caption: "Explore design consultations.", cta: "Meet us", visualDirection: "Warm architectural light", rationale: "A clear introduction", evidenceUsed: [] } } });
  }
  const run = () => runOneWeeklyImage(manageImage, () => store);
  const tick = (f: Fixture) => db.weeklyCycle.update({ where: { id: f.cycle.id }, data: { nextMediaAt: null } });
  const cycle = (f: Fixture) => db.weeklyCycle.findUniqueOrThrow({ where: { id: f.cycle.id }, include: { tasks: true } });
  it("defaults to no images and rejects planning-only image authorization", async () => {
    const f = await setup({ imagesAfterApproval: false }); expect(f.cycle.mediaStatus).toBe("NONE"); expect(f.task.imageStatus).toBe("SKIPPED");
    await expect(savePlanning(f.scope, { ...policy, mode: "PLAN", version: 1 })).rejects.toThrow("draft mode");
    expect(await run()).toBe(false);
  });
  it("waits for human approval, shares copy spend, submits once and requires visual review", async () => {
    const f = await setup(); const revision = await completeCopy(f, "READY");
    await run(); expect(await db.imageGeneration.count({ where: { businessId: f.scope.businessId } })).toBe(0);
    expect(await run()).toBe(false);
    await db.creativeRevision.update({ where: { id: revision.id }, data: { status: "APPROVED" } }); await tick(f);
    await Promise.all([run(), run()]);
    const image = await db.imageGeneration.findFirstOrThrow({ where: { businessId: f.scope.businessId } });
    expect(image.status).toBe("QUEUED"); expect((await cycle(f)).creditsAuthorized).toBe(1 + image.credits);
    expect(await db.imageGeneration.count({ where: { businessId: f.scope.businessId } })).toBe(1);
    const read = (await readPlanning(f.scope)).cycles[0]; expect(read.tasks[0]).toMatchObject({ imageStatus: "AUTHORIZED", imageJobStatus: "QUEUED", imageHeldCredits: image.credits });
    expect(JSON.stringify(read)).not.toMatch(/configurationHash|prompt|references|generationId|actorId/);
    const bytes = await sharp({ create: { width: 128, height: 128, channels: 4, background: "#987654" } }).png().toBuffer();
    const generate = vi.fn(async () => ({ id: "fixture-response", image: bytes, usage: { promptTokenCount: 100, candidatesTokenCount: 100, totalTokenCount: 200 } }));
    await runOneImage(generate, () => store); await runOneImage(generate, () => store); expect(generate).toHaveBeenCalledTimes(1);
    expect(await db.imageGeneration.findUniqueOrThrow({ where: { id: image.id }, include: { output: true } })).toMatchObject({ status: "READY", output: { approvedForGeneration: false } });
    await tick(f); await run(); expect((await cycle(f)).mediaStatus).toBe("COMPLETE");
    expect(await db.socialPublication.count({ where: { businessId: f.scope.businessId } })).toBe(0);
  });
  it("never exceeds the combined ceiling, cancels rejected offers and never requotes", async () => {
    const f = await setup({ creditsPerWeek: 1 }); await completeCopy(f); await run();
    const row = await cycle(f); expect(row.creditsAuthorized).toBe(1); expect(row.mediaStatus).toBe("BLOCKED"); expect(row.tasks[0].imageStatus).toBe("STOPPED");
    const image = await db.imageGeneration.findFirstOrThrow({ where: { businessId: f.scope.businessId } }); expect(image.status).toBe("CANCELLED"); expect(image.reservationId).toBeNull();
    expect(await run()).toBe(false); expect(await db.imageGeneration.count({ where: { businessId: f.scope.businessId } })).toBe(1);
  });
  it("cancellation between quote and acceptance prevents spending and late resurrection", async () => {
    const f = await setup(); await completeCopy(f);
    await runOneWeeklyImage(async (...args) => { const result = await manageImage(...args); if (result.generationId) await cancelWeeklyCycle(f.scope, f.cancel); return result; }, () => store);
    const row = await cycle(f); expect(row.status).toBe("CANCELLED"); expect(row.mediaStatus).toBe("CANCELLED"); expect(row.creditsAuthorized).toBe(1);
    expect(await db.imageGeneration.findFirstOrThrow({ where: { businessId: f.scope.businessId } })).toMatchObject({ status: "CANCELLED", acceptedAt: null });
  });
  it("revoked copy approval between quote and acceptance blocks generation", async () => {
    const f = await setup(); const revision = await completeCopy(f);
    await runOneWeeklyImage(async (...args) => { const result = await manageImage(...args); if (result.generationId) await db.creativeRevision.update({ where: { id: revision.id }, data: { status: "READY" } }); return result; }, () => store);
    expect((await cycle(f)).mediaStatus).toBe("BLOCKED"); expect((await cycle(f)).creditsAuthorized).toBe(1);
  });
  it("preserves manual imagery and lets another business progress while approval is pending", async () => {
    const waiting = await setup(); await completeCopy(waiting, "READY"); const manual = await setup(); await completeCopy(manual);
    const quote = await manageImage(manual.scope, { action: "quote", itemId: manual.task.itemId }, () => store);
    await run(); await run();
    expect((await cycle(manual)).tasks[0].imageStatus).toBe("SKIPPED");
    expect(await db.imageGeneration.findUniqueOrThrow({ where: { id: quote.generationId! } })).toMatchObject({ status: "OFFERED", acceptedAt: null });
    expect((await cycle(waiting)).tasks[0].imageStatus).toBe("WAITING");
  });
  it.each(["brand", "membership", "policy", "week"])("stops after %s changes without authorizing images", async change => {
    const f = await setup(); await completeCopy(f);
    if (change === "brand") await db.business.update({ where: { id: f.scope.businessId }, data: { version: 2 } });
    if (change === "membership") await db.membership.update({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } }, data: { role: "EDITOR" } });
    if (change === "policy") await savePlanning(f.scope, { ...policy, version: 1, imagesAfterApproval: false });
    if (change === "week") await db.weeklyCycle.update({ where: { id: f.cycle.id }, data: { periodKey: "2020-01-06" } });
    await run(); expect((await cycle(f)).mediaStatus).toBe("CANCELLED"); expect(await db.imageGeneration.count({ where: { businessId: f.scope.businessId } })).toBe(0);
  });
  it("resumes an attached quote after a worker restart, not by creating another", async () => {
    const f = await setup(); await completeCopy(f); const leaseUntil = new Date(Date.now() + 60000);
    await db.weeklyCycle.update({ where: { id: f.cycle.id }, data: { mediaLeaseUntil: leaseUntil } });
    const quote = await manageImage(f.scope, { action: "quote", itemId: f.task.itemId }, () => store, { taskId: f.task.id, leaseUntil });
    await expect(manageImage(f.scope, { action: "accept", generationId: quote.generationId }, () => store)).rejects.toThrow("automatic weekly run");
    await db.weeklyCycle.update({ where: { id: f.cycle.id }, data: { mediaLeaseUntil: new Date(0) } }); await run();
    expect(await db.imageGeneration.count({ where: { businessId: f.scope.businessId } })).toBe(1); expect((await cycle(f)).tasks[0].imageStatus).toBe("AUTHORIZED");
  });
  it("stopping a completed-copy run preserves authorized image jobs, holds and cumulative budget", async () => {
    const f = await setup(); await completeCopy(f); await run();
    const before = await db.imageGeneration.findFirstOrThrow({ where: { businessId: f.scope.businessId } });
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } });
    const spend = (await cycle(f)).creditsAuthorized;
    await cancelWeeklyCycle(f.scope, f.cancel); expect(await db.imageGeneration.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } })).toEqual(wallet); expect((await cycle(f)).creditsAuthorized).toBe(spend);
  });
  it("wallet failure rolls back weekly spending, supplier authorization and image attachment", async () => {
    const f = await setup(); await completeCopy(f);
    await db.wallet.update({ where: { organizationId: f.scope.organizationId }, data: { available: 0 } });
    await run(); const image = await db.imageGeneration.findFirstOrThrow({ where: { businessId: f.scope.businessId } });
    expect((await cycle(f)).creditsAuthorized).toBe(1); expect(image.acceptedAt).toBeNull(); expect(image.reservationId).toBeNull();
    expect(await db.supplierAuthorization.count({ where: { key: image.id } })).toBe(0);
    expect(await db.brandAsset.count({ where: { generationId: image.id } })).toBe(0);
  });
  it("expired attached offers stop without a replacement or new spend", async () => {
    const f = await setup(); await completeCopy(f); const leaseUntil = new Date(Date.now() + 60000);
    await db.weeklyCycle.update({ where: { id: f.cycle.id }, data: { mediaLeaseUntil: leaseUntil } });
    const quote = await manageImage(f.scope, { action: "quote", itemId: f.task.itemId }, () => store, { taskId: f.task.id, leaseUntil });
    await db.imageGeneration.update({ where: { id: quote.generationId }, data: { expiresAt: new Date(0) } });
    await db.weeklyCycle.update({ where: { id: f.cycle.id }, data: { mediaLeaseUntil: new Date(0) } }); await run();
    expect((await cycle(f)).mediaStatus).toBe("BLOCKED"); expect(await db.imageGeneration.count({ where: { businessId: f.scope.businessId } })).toBe(1);
  });
  it("rejects forged cross-tenant task bindings and manual attempts to inject internal authorization", async () => {
    const f = await setup(); await completeCopy(f); const other = await setup(); await completeCopy(other);
    const leaseUntil = new Date(Date.now() + 60000); await db.weeklyCycle.update({ where: { id: f.cycle.id }, data: { mediaLeaseUntil: leaseUntil } });
    await expect(manageImage(other.scope, { action: "quote", itemId: other.task.itemId }, () => store, { taskId: f.task.id, leaseUntil })).rejects.toThrow("stale or paused");
    await expect(manageImage(f.scope, { action: "quote", itemId: f.task.itemId, weeklyTaskId: f.task.id }, () => store)).rejects.toThrow();
    expect(await db.imageGeneration.count({ where: { businessId: { in: [f.scope.businessId, other.scope.businessId] } } })).toBe(0);
  });
  it("waits for an existing image job without spending or blocking the run", async () => {
    const f = await setup(); await completeCopy(f);
    const item = await db.productionItem.create({ data: { organizationId: f.scope.organizationId, planId: f.cycle.planId, title: "Manual artwork", format: "static", channel: "Facebook", brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: { headline: "A home", caption: "Design consultations.", cta: "Meet us", visualDirection: "Warm architecture", rationale: "Introduction", evidenceUsed: [] } } } } });
    const quote = await manageImage(f.scope, { action: "quote", itemId: item.id }, () => store);
    await manageImage(f.scope, { action: "accept", generationId: quote.generationId }, () => store);
    await run(); expect((await cycle(f)).mediaStatus).toBe("OPEN"); expect((await cycle(f)).tasks[0].imageStatus).toBe("WAITING"); expect((await cycle(f)).creditsAuthorized).toBe(1);
    await manageImage(f.scope, { action: "cancel", generationId: quote.generationId }, () => store); await tick(f); await run();
    expect((await cycle(f)).tasks[0].imageStatus).toBe("AUTHORIZED");
  });
});
