import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import type { AssetStore } from "../src/lib/assets/storage";
import { manageVideo } from "../src/lib/video/service";
import { storyboardDocument } from "../src/lib/video/document";
import { runOneMotion } from "../src/lib/video/worker";
import { renderMotion, type MotionResult } from "../src/lib/video/render";
import { WORKER_RUNTIME, workerConfigurationHash } from "../src/lib/production/readiness";
import { manageSocial, saveVerifiedConnection } from "../src/lib/social/service";
import { runOnePublication, runOneMetricSync, runOneReconciliation } from "../src/lib/social/worker";
import { createImageTransfer } from "../src/lib/social/image-transfer";
import { createFacebookPublishingAdapter } from "../src/lib/social/facebook-publishing";
import { submissionJournal } from "../src/lib/social/submission-journal";
import { facebookReelFixture } from "./helpers/facebook-reels";
import { readSocialDashboard } from "../src/lib/social/analytics";
import { stopUnsubmittedImage } from "../src/lib/social/prepost-recovery";
import { MAX_RECONCILIATION_ATTEMPTS } from "../src/lib/social/integrity";

const local = process.env.TEST_DATABASE_URL, suite = local ? describe : describe.skip;
if (local && (local !== process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(local).hostname))) throw Error("Local fixture DB required");
suite("Facebook reviewed Reel database lifecycle", () => {
  const orgs: string[] = [], users: string[] = [], workerId = `fb-reel-${crypto.randomUUID()}`, objects = new Map<string, Uint8Array>();
  const store: AssetStore = { put: async (k, b) => { objects.set(k, b); }, get: async k => { const b = objects.get(k); if (!b) throw Error("Missing fixture"); return b; }, remove: async k => { objects.delete(k); } };
  let playable: MotionResult | undefined;
  beforeAll(() => {
    vi.stubEnv("SECRET_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") })); vi.stubEnv("SECRET_ENCRYPTION_ACTIVE_KEY", "test");
    for (const key of ["SOCIAL_EXECUTION_ENABLED", "FACEBOOK_CONNECTIONS_ENABLED", "FACEBOOK_PUBLISHING_ENABLED", "FACEBOOK_REELS_ENABLED", "FACEBOOK_METRICS_ENABLED", "MOTION_RENDERING_ENABLED"]) vi.stubEnv(key, "true");
    vi.stubEnv("MOTION_RENDER_DAILY_LIMIT", "100"); vi.stubEnv("PAID_EXECUTION_ENABLED", "false");
    if (!process.env.TEST_FFMPEG_PATH || !process.env.TEST_FFPROBE_PATH) throw Error("Explicit local FFmpeg tools required");
    vi.stubEnv("FFMPEG_PATH", process.env.TEST_FFMPEG_PATH); vi.stubEnv("FFPROBE_PATH", process.env.TEST_FFPROBE_PATH);
  });
  afterEach(async () => { vi.stubEnv("FACEBOOK_REELS_ENABLED", "true"); await db.socialPublication.deleteMany({ where: { organizationId: { in: orgs } } }); });
  afterAll(async () => {
    const renders = await db.motionRender.findMany({ where: { organizationId: { in: orgs } } });
    await db.motionAuthorization.deleteMany({ where: { key: { in: renders.map(r => r.id) } } });
    await db.motionRender.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.videoStoryboard.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.user.deleteMany({ where: { id: { in: users } } });
    await db.workerHeartbeat.deleteMany({ where: { id: workerId } }); vi.unstubAllEnvs(); await db.$disconnect();
  });
  async function setup(format = "static") {
    const f = facebookReelFixture(), transfer = createImageTransfer(() => store);
    const adapter = createFacebookPublishingAdapter(f.config, f.fetcher, submissionJournal, { enabled: false, transfer });
    const user = await db.user.create({ data: { email: `fb-reel-${crypto.randomUUID()}@example.test`, name: "Local Reel", passwordHash: "not-for-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "FACEBOOK REEL TEST ONLY", memberships: { create: { userId: user.id, role: "OWNER" } } } }); orgs.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Design studio", offering: "Design consultations", confirmedAt: new Date() } });
    const scope = { businessId: business.id, organizationId: org.id, actorId: user.id };
    const plan = await db.productionPlan.create({ data: { organizationId: org.id, businessId: business.id, brandVersion: 1, title: "Local Reel", creditCeiling: 0, items: { create: { title: "Design", channel: "Facebook", format, brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: { headline: "Considered spaces", caption: f.payload.caption, cta: "Meet us", visualDirection: "Approved typography", rationale: "Synthetic test", evidenceUsed: [] } } } } } }, include: { items: { include: { revisions: true } } } });
    const item = plan.items[0], revision = item.revisions[0];
    const storyboardId = (await manageVideo(scope, { action: "create", itemId: item.id }, () => store)).storyboardId!;
    const board = await db.videoStoryboard.findUniqueOrThrow({ where: { id: storyboardId } });
    for (const shot of storyboardDocument.parse(board.document).shots) await manageVideo(scope, { action: "review-shot", storyboardId, shotId: shot.id, approved: true }, () => store);
    await manageVideo(scope, { action: "approve-storyboard", storyboardId }, () => store);
    await db.workerHeartbeat.upsert({ where: { id: workerId }, create: { id: workerId, runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), executionEnabled: false, motionReady: true }, update: { configurationHash: workerConfigurationHash(), lastSeenAt: new Date() } });
    const renderId = (await manageVideo(scope, { action: "render", storyboardId }, () => store)).renderId!;
    await runOneMotion(async (document, assets) => playable ??= await renderMotion(document, assets), () => store);
    await manageVideo(scope, { action: "approve-render", renderId, continuityReviewed: true }, () => store);
    const render = await db.motionRender.findUniqueOrThrow({ where: { id: renderId } });
    const connection = await saveVerifiedConnection(scope, { provider: "Facebook", externalAccountId: f.account.externalAccountId, label: "Synthetic Page", token: f.account.token, permissions: [], expiresAt: new Date(Date.now() + 3600000) });
    const action = { action: "schedule", itemId: item.id, version: 1, connectionId: connection.id, scheduledFor: new Date(Date.now() + 120000).toISOString(), timezone: "UTC", videoRenderId: renderId };
    return { ...f, adapter, transfer, scope, item, revision, storyboardId, render, connection, action };
  }
  async function queue(f: Awaited<ReturnType<typeof setup>>) {
    await manageSocial(f.scope, f.action, { Facebook: f.adapter });
    const post = await db.socialPublication.findFirstOrThrow({ where: { businessId: f.scope.businessId } });
    f.post.created_time = new Date(Date.now() + 100).toISOString();
    await db.socialPublication.update({ where: { id: post.id }, data: { scheduledFor: new Date(Date.now() - 1000) } }); return post;
  }
  it("renders, reviews, uploads exact private MP4 bytes and records a verified post without credits or video metrics", async () => {
    const f = await setup(), post = await queue(f); await runOnePublication({ Facebook: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", externalPostId: f.id, candidatePostId: f.id, mediaUploaded: true, mediaExternalId: f.videoId, mediaDeliveryTokenHash: null, mediaDeliveryBytes: null, nextMetricsAt: null });
    expect(f.fetcher.mock.calls.find(([url]) => String(url).startsWith("https://rupload.facebook.com/"))![1]!.body).toEqual(new Uint8Array(playable!.bytes));
    expect(await runOneMetricSync({ Facebook: f.adapter })).toBe(false);
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
    const dashboard = await readSocialDashboard(f.scope);
    expect(dashboard.publications[0]).toMatchObject({ includesVideo: true, includesImage: false, videoUploadAcknowledged: true });
    for (const secret of ["mediaDelivery", f.account.token, f.render.objectKey, "submissionAdapterVersion"]) expect(JSON.stringify(dashboard)).not.toContain(secret);
    // A legacy feed reading must never make a video appear measured.
    await db.metricSnapshot.create({ data: { organizationId: f.scope.organizationId, businessId: f.scope.businessId, publicationId: post.id, observedAt: new Date(), definitionVersion: "facebook-post-views-unique-clicks-reactions-v26.0-v1", views: 999, impressions: null } });
    expect((await readSocialDashboard(f.scope)).summary[0].metrics.views.value).toBeNull();
  }, 60000);
  it.each(["motion", "video"])("publishes reviewed media from %s work", async format => {
    const f = await setup(format), post = await queue(f); await runOnePublication({ Facebook: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", payload: { format: "video", mediaExportId: f.render.id } });
  });
  it.each(["processing", "lost finish", "lost receipt"])("reconciles %s without any repeated write", async kind => {
    const f = await setup(), post = await queue(f);
    if (kind === "processing") f.video.status.publishing_phase.status = "in_progress";
    if (kind === "lost finish") f.replies[4] = Error("lost finish acknowledgement");
    if (kind === "lost receipt") f.replies[6] = Error("lost post read");
    await runOnePublication({ Facebook: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", mediaUploaded: true, submissionAdapterVersion: expect.stringMatching(/:reel-v1$/) });
    await expect(manageSocial(f.scope, { action: "cancel", publicationId: post.id }, { Facebook: f.adapter })).rejects.toThrow();
    await expect(stopUnsubmittedImage({ organizationId: f.scope.organizationId, businessId: f.scope.businessId, operatorId: "local-operator", publicationId: post.id })).rejects.toThrow("Never abandon an uncertain post");
    f.video.status.publishing_phase.status = "complete";
    f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.capability, f.video, f.post);
    await runOneReconciliation({ Facebook: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", externalPostId: f.id, nextMetricsAt: null });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(3);
  });
  it("bounds asynchronous status reconciliation without retrying publication", async () => {
    const f = await setup(), post = await queue(f); f.video.status.publishing_phase.status = "in_progress";
    await runOnePublication({ Facebook: f.adapter });
    for (let n = 0; n < MAX_RECONCILIATION_ATTEMPTS; n++) {
      f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.capability, f.video);
      await db.socialPublication.update({ where: { id: post.id }, data: { nextReconciliationAt: new Date(0) } });
      expect(await runOneReconciliation({ Facebook: f.adapter })).toBe(true);
    }
    expect(await runOneReconciliation({ Facebook: f.adapter })).toBe(false);
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", reconciliationAttempts: MAX_RECONCILIATION_ATTEMPTS, nextReconciliationAt: null });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(3);
  });
  it("allows only explicit local pre-post recovery after a lost upload acknowledgement", async () => {
    const f = await setup(), post = await queue(f); f.replies[3] = Error("lost upload response");
    await runOnePublication({ Facebook: f.adapter });
    const request = { organizationId: f.scope.organizationId, businessId: f.scope.businessId, publicationId: post.id, operatorId: "local-operator" };
    const preview = await stopUnsubmittedImage(request); expect(preview.mediaKind).toBe("reel");
    expect(await stopUnsubmittedImage({ ...request, apply: true, expectedStateHash: preview.stateHash, evidence: "Local fixture: the exact attempt has no publication fence." })).toMatchObject({ status: "FAILED", applied: true });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });
  it("claims concurrent workers once", async () => {
    const f = await setup(), post = await queue(f);
    await Promise.all([runOnePublication({ Facebook: f.adapter }), runOnePublication({ Facebook: f.adapter })]);
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", attempts: 1 });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(3);
  });
  it.each(["approval", "storyboard", "copy", "brand", "expiry", "bytes", "disabled"])("blocks revoked %s before upload", async kind => {
    const f = await setup(), post = await queue(f);
    if (kind === "approval") await db.motionRender.update({ where: { id: f.render.id }, data: { status: "REJECTED", approvedBy: null } });
    if (kind === "storyboard") await db.videoStoryboard.update({ where: { id: f.storyboardId }, data: { status: "DRAFT" } });
    if (kind === "copy") await db.creativeRevision.update({ where: { id: f.revision.id }, data: { status: "REJECTED" } });
    if (kind === "brand") await db.business.update({ where: { id: f.scope.businessId }, data: { version: { increment: 1 } } });
    if (kind === "expiry") await db.motionRender.update({ where: { id: f.render.id }, data: { purgeAfter: new Date(0) } });
    if (kind === "bytes") objects.set(f.render.objectKey, new Uint8Array([1]));
    if (kind === "disabled") vi.stubEnv("FACEBOOK_REELS_ENABLED", "false");
    await runOnePublication({ Facebook: f.adapter });
    expect((await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).status).not.toBe("PUBLISHED");
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
  it.each([false, true])("rejects Instagram feed placement parameter %s for Facebook", async shareToFeed => {
    const f = await setup(); await expect(manageSocial(f.scope, { ...f.action, shareToFeed }, { Facebook: f.adapter })).rejects.toThrow("Feed placement");
    expect(await db.socialPublication.count({ where: { businessId: f.scope.businessId } })).toBe(0);
  });
  it("denies cross-business render selection and viewer scheduling", async () => {
    const f = await setup(), other = await setup();
    await expect(manageSocial(f.scope, { ...f.action, videoRenderId: other.render.id }, { Facebook: f.adapter })).rejects.toThrow();
    await db.membership.updateMany({ where: { organizationId: f.scope.organizationId }, data: { role: "VIEWER" } });
    await expect(manageSocial(f.scope, f.action, { Facebook: f.adapter })).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("preserves the SQL separation between Facebook uploads and Instagram delivery grants", async () => {
    const f = await setup(), post = await queue(f); await runOnePublication({ Facebook: f.adapter });
    await expect(db.socialPublication.update({ where: { id: post.id }, data: { mediaDeliveryTokenHash: "a".repeat(64), mediaDeliveryExpiresAt: new Date(Date.now() + 60000), mediaDeliverySha256: f.render.sha256, mediaDeliveryBytes: f.render.bytes, mediaDeliveryVersion: "approved-reel-mp4-v1", mediaDeliveryAuthorizationVersion: 1 } })).rejects.toThrow();
    await expect(db.socialPublication.update({ where: { id: post.id }, data: { mediaExternalId: "urn:li:video:invalid" } })).rejects.toThrow();
    await expect(db.socialPublication.update({ where: { id: post.id }, data: { mediaExternalId: null } })).rejects.toThrow();
  });
});
