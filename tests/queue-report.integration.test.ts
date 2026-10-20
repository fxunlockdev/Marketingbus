import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "../src/lib/db";
import { readQueueReport, type QueueReportOptions } from "../scripts/operations/queue-report";
import { purgeExpiredAssets } from "../src/lib/assets/service";
import type { AssetStore } from "../src/lib/assets/storage";
import { purgeCompositionExports } from "../src/lib/composition/exports";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local fixture database required");
const now = new Date("2026-10-18T00:00:00.000Z"), old = new Date(now.getTime() - 3600000), future = new Date(now.getTime() + 3600000);
suite("read-only operator queue inventory", () => {
  const orgs: string[] = [], users: string[] = [], events: string[] = [];
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await db.compositionExport.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.motionRender.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.videoStoryboard.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.videoClip.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.brandAsset.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.videoGeneration.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.billingRefundOperation.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.billingPayment.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.billingEvent.deleteMany({ where: { id: { in: events } } });
    await db.$disconnect();
  });
  async function setup() {
    const org = await db.organization.create({ data: { name: "Queue fixture", wallet: { create: { available: 100 } }, businesses: { create: { name: "Synthetic business" } } }, include: { businesses: true } }); orgs.push(org.id);
    return { organizationId: org.id, businessId: org.businesses[0].id };
  }
  const report = (scope: Awaited<ReturnType<typeof setup>>, extra: Partial<QueueReportOptions> = {}) => readQueueReport(db, { scope: { kind: "organization", ...scope }, ...extra }, now);
  async function job(scope: Awaited<ReturnType<typeof setup>>, status: string, extra = {}) {
    return db.job.create({ data: { ...scope, kind: "STATIC_COPY", key: crypto.randomUUID(), status, payload: { secret: "do-not-output-prompt" }, errorCode: "do-not-output-error-secret", createdAt: old, availableAt: old, ...extra } });
  }
  async function asset(scope: Awaited<ReturnType<typeof setup>>, extra: Prisma.BrandAssetUncheckedUpdateInput = {}) {
    const row = await db.brandAsset.create({ data: { ...scope, objectKey: `never-output-object-${crypto.randomUUID()}`,
      label: "never-output-private-label", purpose: "reference", sha256: "never-output-hash", bytes: 1024, width: 100, height: 100,
      uploadedBy: "never-output-uploader", rightsConfirmedAt: old, createdAt: old, status: "ARCHIVED", purgeAfter: old } });
    return db.brandAsset.update({ where: { id: row.id }, data: extra });
  }
  it.each([
    [{}, "RETENTION_OVERDUE"],
    [{ status: "DELETING", purgeLeaseUntil: old }, "EXPIRED_LEASE"],
    [{ purgeAfter: null }, "RETENTION_STATE_INVALID"],
    [{ status: "DELETING", purgeLeaseUntil: null }, "RETENTION_STATE_INVALID"],
  ] as const)("reports archived asset retention attention %j without exposing or deleting media", async (state, reason) => {
    const scope = await setup(), row = await asset(scope, state);
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } });
    const network = vi.fn(() => { throw Error("No storage request allowed"); }); vi.stubGlobal("fetch", network);
    const result = await report(scope);
    expect(result.items).toEqual([expect.objectContaining({ queue: "asset-retention", id: row.id, reason })]);
    expect(JSON.stringify(result)).not.toMatch(/never-output|objectKey|sha256|uploadedBy|rightsConfirmedAt/);
    expect(await db.brandAsset.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } })).toEqual(wallet);
    expect((await report(await setup())).items).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });
  it.each([
    { status: "READY", purgeAfter: null }, { status: "PENDING", purgeAfter: null },
    { status: "DELETED", bytes: 0 }, { purgeAfter: future }, { purgeAfter: now },
    { status: "DELETING", purgeLeaseUntil: future },
  ])("does not flag ordinary, restored, removed or actively deleting asset state %j", async state => {
    const scope = await setup(); await asset(scope, state);
    expect((await report(scope)).items).toEqual([]);
  });
  it("uses exact purge time, configurable grace and the purge-specific lease", async () => {
    const scope = await setup(), row = await asset(scope, { purgeAfter: new Date(now.getTime() - 15 * 60000) });
    expect((await report(scope)).items[0].reason).toBe("RETENTION_OVERDUE");
    expect((await report(scope, { overdueMinutes: 16 })).items).toEqual([]);
    await db.brandAsset.update({ where: { id: row.id }, data: { status: "DELETING", purgeLeaseUntil: now } });
    expect((await report(scope)).items[0]).toMatchObject({ reason: "EXPIRED_LEASE", leaseActiveAtReportTime: false });
  });
  it("tracks a failed physical purge through its bounded retry lease and confirmed tombstone", async () => {
    const scope = await setup(), row = await asset(scope);
    const remove = vi.fn(async (_key: string): Promise<void> => { throw Error("Synthetic storage failure"); });
    const store = { remove } as unknown as AssetStore;
    // The actual cleanup worker claims globally; use a cutoff before every other
    // fixture so it can touch only this test's explicitly identified object.
    const isolatedTime = new Date("2025-01-01T00:00:00Z");
    await db.brandAsset.update({ where: { id: row.id }, data: { purgeAfter: isolatedTime, createdAt: isolatedTime } });
    await purgeExpiredAssets(store, isolatedTime);
    expect(remove).toHaveBeenCalledExactlyOnceWith(row.objectKey);
    const failed = await db.brandAsset.findUniqueOrThrow({ where: { id: row.id } });
    expect(failed).toMatchObject({ status: "DELETING", bytes: 1024 });
    expect((await readQueueReport(db, { scope: { kind: "organization", ...scope } }, new Date(failed.purgeLeaseUntil!.getTime() - 1))).items).toEqual([]);
    const retryAt = new Date(failed.purgeLeaseUntil!.getTime() + 1);
    expect((await readQueueReport(db, { scope: { kind: "organization", ...scope } }, retryAt)).items[0].reason).toBe("EXPIRED_LEASE");
    // Restore a past lease solely in this fixture, keeping the global purge
    // cutoff isolated from unrelated synthetic records.
    await db.brandAsset.update({ where: { id: row.id }, data: { purgeLeaseUntil: new Date(isolatedTime.getTime() - 1) } });
    remove.mockImplementation(async () => undefined);
    await purgeExpiredAssets(store, isolatedTime);
    expect(await db.brandAsset.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "DELETED", bytes: 0, purgeLeaseUntil: null });
    expect((await report(scope)).items).toEqual([]);
  });
  async function publication(scope: Awaited<ReturnType<typeof setup>>, extra: Prisma.SocialPublicationUncheckedUpdateInput = {}) {
    const connection = await db.socialConnection.findFirst({ where: { ...scope, provider: "LinkedIn" } })
      ?? await db.socialConnection.create({ data: { ...scope, provider: "LinkedIn", externalAccountId: crypto.randomUUID(), label: "Private account label", encryptedToken: "never-output-social-secret", permissions: ["private-permission"], createdAt: old } });
    const plan = await db.productionPlan.create({ data: { ...scope, brandVersion: 1, title: "Private plan", creditCeiling: 0, items: { create: { title: "Private item", channel: "LinkedIn", format: "static", brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: { caption: "never-output-private-caption" } } } } } }, include: { items: { include: { revisions: true } } } });
    const post = await db.socialPublication.create({ data: { ...scope, connectionId: connection.id, revisionId: plan.items[0].revisions[0].id, brandVersion: 1, status: "PUBLISHED", externalPostId: crypto.randomUUID(), publishedAt: old, scheduledFor: old, timezone: "UTC", payload: { secret: "never-output-private-payload" }, payloadHash: "fixture", createdAt: old } });
    return db.socialPublication.update({ where: { id: post.id }, data: extra });
  }
  type MediaState = { status?: string; purgeAfter?: Date; leaseUntil?: Date | null; createdAt?: Date };
  type MediaKind = "clip" | "audio" | "motion" | "export";
  async function media(scope: Awaited<ReturnType<typeof setup>>, kind: MediaKind) {
    const shared = { ...scope, status: "READY", objectKey: `never-output-object-${crypto.randomUUID()}`,
      sha256: "never-output-hash", bytes: 1024, createdBy: "never-output-creator", createdAt: old, purgeAfter: old };
    if (kind === "clip" || kind === "audio") {
      const row = await db.videoClip.create({ data: { ...shared, brandVersion: 1, label: "never-output-label",
        mediaKind: kind === "audio" ? "AUDIO" : "VIDEO", instrumentalConfirmedAt: kind === "audio" ? old : null,
        rightsConfirmedAt: old, sourceKey: `never-output-source-${crypto.randomUUID()}`, sourceHash: "never-output-source-hash",
        sourceBytes: 1024, processorVersion: kind === "audio" ? "instrumental-pcm-v1" : "fixture", durationMs: 1000 } });
      return { row, queue: "clips", get: () => db.videoClip.findUniqueOrThrow({ where: { id: row.id } }),
        update: (data: MediaState) => db.videoClip.update({ where: { id: row.id }, data }) };
    }
    if (kind === "motion") {
      const plan = await db.productionPlan.create({ data: { ...scope, brandVersion: 1, title: "Private plan",
        creditCeiling: 0, items: { create: { title: "Private item", channel: "Instagram", format: "video", brief: {} } } }, include: { items: true } });
      const storyboard = await db.videoStoryboard.create({ data: { ...scope, itemId: plan.items[0].id, brandVersion: 1,
        version: 1, document: {}, shotApprovals: {}, authorId: "fixture" } });
      const row = await db.motionRender.create({ data: { ...shared, storyboardId: storyboard.id,
        rendererVersion: "fixture", documentHash: "never-output-document-hash", durationMs: 1000 } });
      return { row, queue: "motion", get: () => db.motionRender.findUniqueOrThrow({ where: { id: row.id } }),
        update: (data: MediaState) => db.motionRender.update({ where: { id: row.id }, data }) };
    }
    const composition = await db.staticComposition.create({ data: { ...scope, itemId: crypto.randomUUID(),
      revisionId: crypto.randomUUID(), brandVersion: 1, version: 1, document: {} } });
    const row = await db.compositionExport.create({ data: { ...shared, compositionId: composition.id,
      placement: "square", rendererVersion: "fixture", manifest: { private: "never-output-manifest" } } });
    return { row, queue: "exports", get: () => db.compositionExport.findUniqueOrThrow({ where: { id: row.id } }),
      update: (data: MediaState) => db.compositionExport.update({ where: { id: row.id }, data }) };
  }
  it.each(["clip", "audio", "motion", "export"] as const)("reports expired %s media without storage access, mutation or tenant disclosure", async kind => {
    const scope = await setup(), fixture = await media(scope, kind);
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } });
    const network = vi.fn(() => { throw Error("No external request allowed"); }); vi.stubGlobal("fetch", network);
    const result = await report(scope);
    expect(result.items).toEqual([expect.objectContaining({ queue: fixture.queue, id: fixture.row.id, status: "READY", reason: "RETENTION_OVERDUE" })]);
    expect(JSON.stringify(result)).not.toMatch(/never-output|objectKey|sha256|manifest|sourceKey|createdBy/);
    expect(await fixture.get()).toEqual(fixture.row);
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } })).toEqual(wallet);
    expect((await report(await setup())).items).toEqual([]);
    const sibling = await db.business.create({ data: { organizationId: scope.organizationId, name: "Sibling" } });
    expect((await report({ ...scope, businessId: sibling.id })).items).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });
  it.each(["clip", "audio", "motion", "export"] as const)("distinguishes %s retention, processing, failure, grace and deletion leases", async kind => {
    const scope = await setup(), fixture = await media(scope, kind);
    for (const status of ["READY", "APPROVED", "REJECTED", "ARCHIVED"]) {
      await fixture.update({ status });
      expect((await report(scope)).items[0]).toMatchObject({ status, reason: "RETENTION_OVERDUE" });
    }
    for (const state of [
      { status: "DELETED" }, { status: "READY", purgeAfter: future }, { purgeAfter: now },
      { purgeAfter: old, leaseUntil: future }, { status: "DELETING", leaseUntil: future },
    ]) {
      await fixture.update(state);
      expect((await report(scope)).items).toEqual([]);
    }
    await fixture.update({ status: "READY", leaseUntil: null, purgeAfter: new Date(now.getTime() - 15 * 60000) });
    expect((await report(scope)).items[0].reason).toBe("RETENTION_OVERDUE");
    expect((await report(scope, { overdueMinutes: 16 })).items).toEqual([]);
    await fixture.update({ status: "DELETING" });
    expect((await report(scope)).items[0].reason).toBe("RETENTION_STATE_INVALID");
    await fixture.update({ leaseUntil: now });
    expect((await report(scope)).items[0].reason).toBe("EXPIRED_LEASE");
    await fixture.update({ status: "FAILED" });
    expect((await report(scope)).items[0].reason).toBe("FAILED");
    await fixture.update({ status: "STORING", purgeAfter: future });
    expect((await report(scope)).items[0].reason).toBe("EXPIRED_LEASE");
    // An ancient creation time must not turn a future media deadline into retention attention.
    await fixture.update({ status: "READY", leaseUntil: null });
    expect((await report(scope)).items).toEqual([]);
  });
  it.each(["SUBMITTING", "NEEDS_RECONCILIATION"])("explains an export's %s publication hold without changing the post", async status => {
    const scope = await setup(), fixture = await media(scope, "export");
    const post = await publication(scope, { status, leaseUntil: future, payload: { mediaExportId: fixture.row.id } });
    const result = await report(scope);
    expect(result.items.find(r => r.queue === "exports")).toMatchObject({ id: fixture.row.id, reason: "RETENTION_PUBLICATION_HOLD" });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toEqual(post);
    await fixture.update({ leaseUntil: future });
    expect((await report(scope)).items.some(r => r.queue === "exports")).toBe(false);
    await fixture.update({ leaseUntil: null });
    for (const terminal of ["PUBLISHED", "CANCELLED", "FAILED", "SCHEDULED"]) {
      await db.socialPublication.update({ where: { id: post.id }, data: { status: terminal } });
      expect((await report(scope)).items.find(r => r.queue === "exports")?.reason).toBe("RETENTION_OVERDUE");
    }
  });
  it.each(["organization", "business"])("does not infer a retention hold from another %s's untrusted payload", async boundary => {
    const scope = await setup(), fixture = await media(scope, "export");
    const other = boundary === "organization" ? await setup()
      : { ...scope, businessId: (await db.business.create({ data: { organizationId: scope.organizationId, name: "Sibling" } })).id };
    await publication(other, { status: "NEEDS_RECONCILIATION", payload: { mediaExportId: fixture.row.id } });
    expect((await report(scope)).items).toEqual([expect.objectContaining({ queue: "exports", reason: "RETENTION_OVERDUE" })]);
  });
  it("matches the real export publication hold, failed storage retry and confirmed purge lifecycle", async () => {
    const scope = await setup(), fixture = await media(scope, "export");
    const isolatedTime = new Date("2025-01-01T00:00:00Z");
    await fixture.update({ createdAt: isolatedTime, purgeAfter: isolatedTime });
    const post = await publication(scope, { status: "NEEDS_RECONCILIATION", payload: { mediaExportId: fixture.row.id } });
    const remove = vi.fn(async (_key: string): Promise<void> => { throw Error("Synthetic storage failure"); });
    const store = { remove } as unknown as AssetStore;
    await purgeCompositionExports(store, isolatedTime);
    expect(remove).not.toHaveBeenCalled();
    expect((await report(scope)).items.find(r => r.queue === "exports")?.reason).toBe("RETENTION_PUBLICATION_HOLD");
    await db.socialPublication.update({ where: { id: post.id }, data: { status: "CANCELLED" } });
    await purgeCompositionExports(store, isolatedTime);
    expect(remove).toHaveBeenCalledExactlyOnceWith(fixture.row.objectKey);
    const failed = await fixture.get();
    expect(failed).toMatchObject({ status: "DELETING", bytes: 1024 });
    const retryAt = new Date(failed.leaseUntil!.getTime() + 1);
    expect((await readQueueReport(db, { scope: { kind: "organization", ...scope } }, retryAt)).items.find(r => r.queue === "exports")?.reason).toBe("EXPIRED_LEASE");
    await fixture.update({ leaseUntil: new Date(isolatedTime.getTime() - 1) });
    remove.mockImplementation(async () => undefined);
    await purgeCompositionExports(store, isolatedTime);
    expect(await fixture.get()).toMatchObject({ status: "DELETED", bytes: 0, leaseUntil: null });
    expect((await report(scope)).items.some(r => r.queue === "exports")).toBe(false);
  });
  it("isolates organizations and businesses, including mismatched pairs", async () => {
    const a = await setup(), b = await setup(); const first = await job(a, "FAILED"); await job(b, "FAILED");
    const sibling = await db.business.create({ data: { organizationId: a.organizationId, name: "Sibling" } });
    const second = await job({ organizationId: a.organizationId, businessId: sibling.id }, "FAILED");
    expect((await report(a)).items.map(r => r.id)).toEqual([first.id]);
    expect((await report(a, { scope: { kind: "organization", organizationId: a.organizationId } })).items.map(r => r.id).sort()).toEqual([first.id, second.id].sort());
    await expect(report({ ...a, businessId: b.businessId })).rejects.toThrow("scope not found");
    await expect(report(a, { scope: { kind: "organization", organizationId: "missing-fixture-organization" } })).rejects.toThrow("scope not found");
  });
  it("reports failure, uncertainty, overdue work and expired leases without resending or ledger changes", async () => {
    const scope = await setup();
    await job(scope, "FAILED"); await job(scope, "NEEDS_RECONCILIATION"); await job(scope, "QUEUED");
    await job(scope, "SUBMITTING", { leaseUntil: old });
    const before = await db.job.findMany({ where: scope, orderBy: { id: "asc" } });
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } });
    const network = vi.fn(() => { throw Error("No network permitted"); }); vi.stubGlobal("fetch", network);
    const result = await report(scope);
    expect(result.items.map(r => r.reason).sort()).toEqual(["EXPIRED_LEASE", "FAILED", "OVERDUE", "UNCERTAIN_OUTCOME"]);
    expect(JSON.stringify(result)).not.toMatch(/do-not-output|payload|errorCode|encrypted|providerTaskId/);
    expect(await db.job.findMany({ where: scope, orderBy: { id: "asc" } })).toEqual(before);
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } })).toEqual(wallet);
    expect(network).not.toHaveBeenCalled();
  });
  it("does not flag future schedules, active leases, fresh queues or successful/cancelled work", async () => {
    const scope = await setup();
    await job(scope, "QUEUED", { availableAt: future }); await job(scope, "SUBMITTING", { leaseUntil: future });
    await job(scope, "QUEUED", { availableAt: now }); await job(scope, "COMPLETED"); await job(scope, "CANCELLED");
    expect((await report(scope)).items).toEqual([]);
    await job(scope, "NEEDS_RECONCILIATION", { leaseUntil: future });
    expect((await report(scope)).items[0]).toMatchObject({ reason: "UNCERTAIN_OUTCOME", leaseActiveAtReportTime: true });
  });
  it("reports the independent weekly-image phase without confusing completed copy or active review backoff", async () => {
    const scope = await setup();
    const cycle = await db.weeklyCycle.create({ data: { ...scope, periodKey: "2026-10-12", planId: "fixture-plan", brandVersion: 1, policyVersion: 1, status: "COMPLETE", mediaStatus: "OPEN", createdAt: old, nextMediaAt: future } });
    expect((await report(scope)).items).toEqual([]);
    await db.weeklyCycle.update({ where: { id: cycle.id }, data: { nextMediaAt: old } });
    expect((await report(scope)).items).toEqual([expect.objectContaining({ queue: "weekly-images", id: cycle.id, status: "OPEN", reason: "OVERDUE" })]);
    await db.weeklyCycle.update({ where: { id: cycle.id }, data: { mediaLeaseUntil: old } });
    expect((await report(scope)).items[0].reason).toBe("EXPIRED_LEASE");
    await db.weeklyCycle.update({ where: { id: cycle.id }, data: { mediaStatus: "BLOCKED", mediaLeaseUntil: null } });
    expect((await report(scope)).items[0].reason).toBe("FAILED");
    await db.weeklyCycle.update({ where: { id: cycle.id }, data: { mediaStatus: "COMPLETE" } });
    expect((await report(scope)).items).toEqual([]);
  });
  it("reports video hand-off failures independently of completed copy and normal review waits", async () => {
    const scope = await setup();
    const cycle = await db.weeklyCycle.create({ data: { ...scope, periodKey: "2026-10-12", planId: "fixture-plan", brandVersion: 1, policyVersion: 1, status: "COMPLETE", videoStatus: "OPEN", createdAt: old, nextVideoAt: future } });
    expect((await report(scope)).items).toEqual([]);
    await db.weeklyCycle.update({ where: { id: cycle.id }, data: { nextVideoAt: old } });
    expect((await report(scope)).items).toEqual([expect.objectContaining({ queue: "weekly-video", id: cycle.id, reason: "OVERDUE" })]);
    await db.weeklyCycle.update({ where: { id: cycle.id }, data: { videoLeaseUntil: old } });
    expect((await report(scope)).items[0].reason).toBe("EXPIRED_LEASE");
    await db.weeklyCycle.update({ where: { id: cycle.id }, data: { videoStatus: "BLOCKED", videoLeaseUntil: null } });
    expect((await report(scope)).items[0].reason).toBe("FAILED");
    await db.weeklyCycle.update({ where: { id: cycle.id }, data: { videoStatus: "CANCELLED" } });
    expect((await report(scope)).items).toEqual([]);
  });
  it("reports expired access and required renewal without exposing credentials or flagging non-expiring grants", async () => {
    const scope = await setup();
    const account = await db.socialConnection.create({ data: { ...scope, provider: "Facebook", externalAccountId: "private-account", label: "Private label", encryptedToken: "private-token", permissions: ["private-permission"], createdAt: old } });
    expect((await report(scope)).items).toEqual([]);
    await db.socialConnection.update({ where: { id: account.id }, data: { expiresAt: old } });
    expect((await report(scope)).items).toEqual([expect.objectContaining({ queue: "social-access", id: account.id, reason: "OVERDUE" })]);
    await db.socialConnection.update({ where: { id: account.id }, data: { status: "RECONNECT_REQUIRED", encryptedToken: "", permissions: [], expiresAt: null } });
    const result = await report(scope);
    expect(result.items).toEqual([expect.objectContaining({ queue: "social-access", status: "RECONNECT_REQUIRED", reason: "ACCESS_RENEWAL_REQUIRED" })]);
    expect(JSON.stringify(result)).not.toMatch(/private-account|Private label|private-token|private-permission|encryptedToken/);
    expect((await report(await setup())).items).toEqual([]);
    await db.socialConnection.update({ where: { id: account.id }, data: { status: "DISCONNECTED" } });
    expect((await report(scope)).items).toEqual([]);
  });
  it.each([
    [{ metricsFailures: 5 }, "METRICS_STOPPED"],
    [{ errorCode: "METRICS_NOT_ENABLED" }, "METRICS_STOPPED"],
    [{ errorCode: "METRICS_CONTEXT_CHANGED" }, "METRICS_STOPPED"],
    [{ metricsInvalidatedAt: old, errorCode: "METRICS_SOURCE_CHANGED" }, "METRIC_SOURCE_INVALIDATED"],
    [{ nextMetricsAt: old }, "OVERDUE"],
    [{ nextMetricsAt: old, metricsLeaseUntil: old }, "EXPIRED_LEASE"],
  ] as const)("surfaces analytics attention %j independently from a successful publication", async (state, reason) => {
    const scope = await setup(), post = await publication(scope, state);
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } });
    const network = vi.fn(() => { throw Error("Operator inventory must not call a provider"); }); vi.stubGlobal("fetch", network);
    const result = await report(scope);
    expect(result.items).toEqual([expect.objectContaining({ queue: "social-metrics", id: post.id, status: "PUBLISHED", reason })]);
    expect(JSON.stringify(result)).not.toMatch(/never-output|Private|encryptedToken|externalPostId|payloadHash|errorCode/);
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toEqual(post);
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } })).toEqual(wallet);
    expect(network).not.toHaveBeenCalled();
    expect((await report(await setup())).items).toEqual([]);
  });
  it.each([
    {}, { nextMetricsAt: future }, { nextMetricsAt: now }, { nextMetricsAt: old, metricsLeaseUntil: future },
    { metricsFailures: 4 }, { metricsFailures: 5, nextMetricsAt: future },
    { errorCode: "METRICS_NOT_ENABLED", nextMetricsAt: future },
    { metricsFailures: 5, publishedAt: new Date(now.getTime() - 31 * 86400000) },
    { metricsFailures: 5, publishedAt: future }, { metricsFailures: 5, status: "CANCELLED" },
    { metricsFailures: 5, metricsLeaseUntil: future },
  ])("does not flag normal, backoff, active or out-of-window metrics %j", async state => {
    const scope = await setup(); await publication(scope, state);
    expect((await report(scope)).items).toEqual([]);
  });
  it.each([{ publishedAt: null }, { externalPostId: null }])("preserves database rejection of incomplete published receipts %j", async state => {
    const scope = await setup();
    await expect(publication(scope, state)).rejects.toThrow();
    expect((await report(scope)).items).toEqual([]);
  });
  it("uses the metric lease and exact due/publication boundaries, not the old publishing lease", async () => {
    const scope = await setup();
    const post = await publication(scope, { publishedAt: new Date(now.getTime() - 30 * 86400000), nextMetricsAt: new Date(now.getTime() - 15 * 60000), leaseUntil: future });
    expect((await report(scope)).items).toEqual([expect.objectContaining({ queue: "social-metrics", id: post.id, reason: "OVERDUE", leaseActiveAtReportTime: false })]);
    expect((await report(scope, { overdueMinutes: 16 })).items).toEqual([]);
    await db.socialPublication.update({ where: { id: post.id }, data: { metricsLeaseUntil: now } });
    expect((await report(scope)).items[0].reason).toBe("EXPIRED_LEASE");
  });
  it("paginates equal timestamps without duplicates, freezes cutoff and rejects cross-scope cursors", async () => {
    const scope = await setup();
    for (let i = 0; i < 2; i++) await job(scope, "FAILED");
    for (let i = 0; i < 3; i++) await publication(scope, { metricsFailures: 5 });
    const first = await report(scope, { limit: 2 });
    expect(first.hasMore).toBe(true); expect(first.nextCursor).toBeTruthy();
    await job(scope, "FAILED", { createdAt: future });
    const second = await readQueueReport(db, { scope: first.scope, limit: 2, cursor: first.nextCursor! }, future);
    const third = await readQueueReport(db, { scope: first.scope, limit: 2, cursor: second.nextCursor! }, future);
    expect(new Set([...first.items, ...second.items, ...third.items].map(r => r.id)).size).toBe(5);
    expect(third.hasMore).toBe(false); expect(third.nextCursor).toBeNull(); expect(third.asOf).toBe(now.toISOString());
    await expect(report(await setup(), { cursor: first.nextCursor! })).rejects.toThrow("scope");
    await expect(report(scope, { cursor: first.nextCursor!, overdueMinutes: 60 })).rejects.toThrow("scope");
  });
  it("never assigns global payment events or identity email to a tenant from untrusted payloads", async () => {
    const scope = await setup();
    const user = await db.user.create({ data: { email: `${crypto.randomUUID()}@example.test`, name: "Operator fixture", passwordHash: "not-a-password", memberships: { create: { organizationId: scope.organizationId } } } }); users.push(user.id);
    const mail = await db.emailOutbox.create({ data: { id: crypto.randomUUID(), userId: user.id, kind: "RECOVERY", encryptedPayload: "never-output-email-token", status: "FAILED", createdAt: old, expiresAt: future } });
    const event = await db.billingEvent.create({ data: { id: crypto.randomUUID(), payload: { organizationId: scope.organizationId, secret: "never-output-payment-data" }, digest: "fixture", status: "NEEDS_REVIEW", createdAt: old } }); events.push(event.id);
    const scoped = await report(scope, { scope: { kind: "organization", organizationId: scope.organizationId } });
    expect(scoped.items).toEqual([]); expect(scoped.excludedQueues).toEqual(["payments", "email"]);
    const global = await readQueueReport(db, { scope: { kind: "all" }, limit: 100 }, now);
    expect(global.items.find(r => r.id === mail.id)).toMatchObject({ queue: "email", organizationId: null, businessId: null });
    expect(global.items.find(r => r.id === event.id)).toMatchObject({ queue: "payments", reason: "UNCERTAIN_OUTCOME" });
    expect(JSON.stringify(global)).not.toMatch(/never-output|example.test/);
  });
  it("covers organization checkout/refund uncertainty without modifying payment accounting", async () => {
    const scope = await setup();
    const checkout = await db.billingCheckout.create({ data: { organizationId: scope.organizationId, actorId: "fixture", offer: {}, status: "UNKNOWN", createdAt: old, expiresAt: future, url: "https://example.test/secret" } });
    const payment = await db.billingPayment.create({ data: { id: crypto.randomUUID(), organizationId: scope.organizationId, amountMinor: 80000, currency: "usd", generalCredits: 100, revisionCredits: 10 } });
    const refund = await db.billingRefundOperation.create({ data: { id: crypto.randomUUID(), paymentId: payment.id, organizationId: scope.organizationId, amountMinor: 100, status: "UNKNOWN", operatorId: "fixture", evidence: "never-output-private-evidence", createdAt: old } });
    const result = await report(scope, { scope: { kind: "organization", organizationId: scope.organizationId } });
    expect(result.items.map(r => r.id).sort()).toEqual([checkout.id, refund.id].sort());
    expect((await report(scope)).excludedQueues).toContain("refunds"); expect((await report(scope)).items).toEqual([]);
    expect(await db.billingPayment.findUniqueOrThrow({ where: { id: payment.id } })).toEqual(payment);
    expect(JSON.stringify(result)).not.toMatch(/secret|private-evidence|amountMinor/);
  });
  it("uses due dates and expired polling leases for generated video, and flags blocked weekly plans", async () => {
    const scope = await setup();
    const base = { ...scope, actorId: "fixture", storyboardId: "fixture", itemId: "fixture", brandVersion: 1, shotId: "fixture", shotLabel: "fixture", documentHash: "fixture", prompt: "private prompt", route: {}, configurationHash: "fixture", durationMs: 1000, credits: 1, supplierCeilingMicros: 1, expiresAt: future, createdAt: old };
    await db.videoGeneration.create({ data: { ...base, status: "POLLING", nextPollAt: future } });
    await db.videoGeneration.create({ data: { ...base, status: "QUEUED", acceptedAt: now } });
    const expired = await db.videoGeneration.create({ data: { ...base, status: "POLLING", nextPollAt: old, leaseUntil: old } });
    const cycle = await db.weeklyCycle.create({ data: { ...scope, periodKey: "fixture", policyVersion: 1, brandVersion: 1, planId: "fixture", status: "BLOCKED", createdAt: old } });
    const result = await report(scope);
    expect(result.items.find(r => r.id === expired.id)?.reason).toBe("EXPIRED_LEASE");
    expect(result.items.find(r => r.id === cycle.id)?.reason).toBe("FAILED"); expect(result.items).toHaveLength(2);
  });
  it("respects configurable overdue threshold including the exact boundary", async () => {
    const scope = await setup(); await job(scope, "QUEUED", { availableAt: new Date(now.getTime() - 15 * 60000) });
    expect((await report(scope)).items).toHaveLength(1);
    expect((await report(scope, { overdueMinutes: 16 })).items).toEqual([]);
  });
  it.each(["READY", "FAILED"])("surfaces %s provisional supplier expense without secrets or changes to settlement", async status => {
    const scope = await setup();
    const record = await db.videoGeneration.create({ data: { ...scope, actorId: "fixture", storyboardId: "fixture", itemId: "fixture", brandVersion: 1, shotId: "fixture", shotLabel: "fixture", documentHash: "fixture", prompt: "private prompt", route: {}, configurationHash: "fixture", durationMs: 1000, credits: 1, supplierCeilingMicros: 1, supplierEstimateMicros: 1, expenseBasis: "ACCOUNT_QUOTE_V1", status, settledAt: old, expiresAt: future, createdAt: old, receipt: { evidence: "private invoice" } } });
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } });
    const result = await report(scope);
    expect(result.items.find(r => r.id === record.id)).toMatchObject({ queue: "video", status, reason: "SUPPLIER_INVOICE_DUE" });
    expect(JSON.stringify(result)).not.toMatch(/private|receipt|supplierEstimateMicros/);
    expect(await db.videoGeneration.findUniqueOrThrow({ where: { id: record.id } })).toEqual(record);
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: scope.organizationId } })).toEqual(wallet);
    await db.videoGeneration.update({ where: { id: record.id }, data: { supplierCostMicros: 1, supplierReconciledAt: old } });
    expect((await report(scope)).items.some(r => r.reason === "SUPPLIER_INVOICE_DUE")).toBe(false);
  });
  it("executes under PostgreSQL read-only enforcement and a bounded statement timeout", async () => {
    const scope = await setup(); let inspected = false;
    const client = { $transaction: (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: { timeout?: number }) => db.$transaction(async tx => {
      const result = await callback(tx);
      const settings = await tx.$queryRaw<{ readonly: string; timeout: string }[]>`SELECT current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS timeout`;
      expect(settings).toEqual([{ readonly: "on", timeout: "3s" }]); inspected = true; return result;
    }, options) } as unknown as PrismaClient;
    await readQueueReport(client, { scope: { kind: "organization", ...scope } }, now);
    expect(inspected).toBe(true);
  });
  it("CLI distinguishes a healthy scoped report, attention, invalid scope and unsafe monitoring pagination", async () => {
    const scope = await setup();
    const run = async (...args: string[]) => {
      try { return { code: 0, ...await promisify(execFile)(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/queue-report.ts", ...args], { env: { NODE_ENV: "test", PATH: process.env.PATH, DATABASE_URL: process.env.TEST_DATABASE_URL }, encoding: "utf8", timeout: 15000, maxBuffer: 128000 }) }; }
      catch (error) { const result = error as { code: number; stdout: string; stderr: string }; return { code: result.code, stdout: result.stdout, stderr: result.stderr }; }
    };
    expect((await run("--organization", scope.organizationId, "--check")).code).toBe(0);
    // The subprocess uses its real clock, unlike report()'s fixed test timestamp.
    const stopped = await publication(scope, { metricsFailures: 5, publishedAt: new Date(Date.now() - 3600000) });
    const metricAttention = await run("--organization", scope.organizationId, "--check");
    expect(metricAttention.code).toBe(2);
    expect(JSON.parse(metricAttention.stdout).items).toEqual([expect.objectContaining({ id: stopped.id, queue: "social-metrics", reason: "METRICS_STOPPED" })]);
    await db.socialPublication.update({ where: { id: stopped.id }, data: { metricsFailures: 0 } });
    const failed = await job(scope, "FAILED", { createdAt: new Date("2026-10-01T00:00:00Z") });
    const attention = await run("--organization", scope.organizationId, "--check");
    expect(attention.code).toBe(2); expect(JSON.parse(attention.stdout).items[0].id).toBe(failed.id);
    for (const args of [[], ["--all", "--organization", scope.organizationId], ["--organization", "missing-fixture-scope"], ["--all", "--check", "--cursor", "private-token-fixture"]]) {
      const result = await run(...args); expect(result.code).toBe(1); expect(result.stdout).toBe("");
      expect(result.stderr).toContain("No recovery action was taken"); expect(result.stderr).not.toMatch(/private-token|postgresql|Prisma/);
    }
  }, 30000);
});

describe("queue inventory input guards", () => {
  it.each([
    {}, { scope: { kind: "all" }, limit: 101 }, { scope: { kind: "all" }, limit: 0 },
    { scope: { kind: "all" }, overdueMinutes: 0 }, { scope: { kind: "all", organizationId: "tenant" } },
    { scope: { kind: "organization", organizationId: "' OR true --" } },
    { scope: { kind: "all" }, cursor: "invalid" }, { scope: { kind: "all" }, mutate: true },
  ])("refuses malformed or unsafe options before querying: %j", async raw => {
    const transaction = vi.spyOn(db, "$transaction");
    try { await expect(readQueueReport(db, raw as QueueReportOptions, now)).rejects.toThrow(); expect(transaction).not.toHaveBeenCalled(); }
    finally { transaction.mockRestore(); }
  });
});
