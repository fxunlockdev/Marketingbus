import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";
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
import { createLinkedInPublishingAdapter } from "../src/lib/social/linkedin-publishing";
import { submissionJournal } from "../src/lib/social/submission-journal";
import { linkedInVideoFixture } from "./helpers/linkedin-video";
import { readSocialDashboard } from "../src/lib/social/analytics";
import { stopUnsubmittedImage } from "../src/lib/social/prepost-recovery";

const local = process.env.TEST_DATABASE_URL, suite = local ? describe : describe.skip;
if (local && (local !== process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(local).hostname))) throw Error("Local fixture DB required");
suite("LinkedIn reviewed final-video database lifecycle", () => {
  const orgs: string[] = [], users: string[] = [], workerId = `li-video-${crypto.randomUUID()}`, objects = new Map<string, Uint8Array>();
  const store: AssetStore = { put: async (k, b) => { objects.set(k, b); }, get: async k => { const b = objects.get(k); if (!b) throw Error("Missing fixture"); return b; }, remove: async k => { objects.delete(k); } };
  let playable: MotionResult | undefined;
  let artwork: Buffer;
  beforeAll(async () => {
    artwork = await sharp(randomBytes(640 * 640 * 3), { raw: { width: 640, height: 640, channels: 3 } }).webp({ quality: 80 }).toBuffer();
    vi.stubEnv("SECRET_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") })); vi.stubEnv("SECRET_ENCRYPTION_ACTIVE_KEY", "test");
    for (const key of ["SOCIAL_EXECUTION_ENABLED", "LINKEDIN_CONNECTIONS_ENABLED", "LINKEDIN_PUBLISHING_ENABLED", "LINKEDIN_VIDEO_PUBLISHING_ENABLED", "MOTION_RENDERING_ENABLED"]) vi.stubEnv(key, "true");
    vi.stubEnv("MOTION_RENDER_DAILY_LIMIT", "100"); vi.stubEnv("PAID_EXECUTION_ENABLED", "false");
    if (!process.env.TEST_FFMPEG_PATH || !process.env.TEST_FFPROBE_PATH) throw Error("Explicit local FFmpeg tools required");
    vi.stubEnv("FFMPEG_PATH", process.env.TEST_FFMPEG_PATH); vi.stubEnv("FFPROBE_PATH", process.env.TEST_FFPROBE_PATH);
  });
  afterEach(async () => { vi.stubEnv("LINKEDIN_VIDEO_PUBLISHING_ENABLED", "true"); await db.socialPublication.deleteMany({ where: { organizationId: { in: orgs } } }); });
  afterAll(async () => {
    const renders = await db.motionRender.findMany({ where: { organizationId: { in: orgs } } });
    await db.motionAuthorization.deleteMany({ where: { key: { in: renders.map(r => r.id) } } });
    await db.motionRender.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.videoStoryboard.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.brandAsset.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.user.deleteMany({ where: { id: { in: users } } });
    await db.workerHeartbeat.deleteMany({ where: { id: workerId } }); vi.unstubAllEnvs(); await db.$disconnect();
  });
  async function setup() {
    const f = linkedInVideoFixture(), transfer = createImageTransfer(() => store);
    const adapter = createLinkedInPublishingAdapter(f.config, f.fetcher, submissionJournal, { enabled: false, transfer });
    const user = await db.user.create({ data: { email: `li-video-${crypto.randomUUID()}@example.test`, name: "Local video", passwordHash: "not-for-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "LINKEDIN VIDEO TEST ONLY", memberships: { create: { userId: user.id, role: "OWNER" } } } }); orgs.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Design studio", offering: "Design consultations", confirmedAt: new Date() } });
    const scope = { businessId: business.id, organizationId: org.id, actorId: user.id };
    const plan = await db.productionPlan.create({ data: { organizationId: org.id, businessId: business.id, brandVersion: 1, title: "Local video", creditCeiling: 0, items: { create: { title: "Design", channel: "LinkedIn", format: "static", brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: { headline: "Considered spaces", caption: f.payload.caption, cta: "Meet us", visualDirection: "Approved typography", rationale: "Synthetic test", evidenceUsed: [] } } } } } }, include: { items: { include: { revisions: true } } } });
    const item = plan.items[0], revision = item.revisions[0];
    const asset = await db.brandAsset.create({ data: { organizationId: org.id, businessId: business.id, objectKey: `fixture/${crypto.randomUUID()}`, purpose: "reference", label: "Synthetic texture", sha256: createHash("sha256").update(artwork).digest("hex"), bytes: artwork.length, width: 640, height: 640, status: "READY", approvedForGeneration: true, uploadedBy: user.id, rightsConfirmedAt: new Date() } });
    objects.set(asset.objectKey, artwork);
    let storyboardId = (await manageVideo(scope, { action: "create", itemId: item.id }, () => store)).storyboardId!;
    const document = storyboardDocument.parse((await db.videoStoryboard.findUniqueOrThrow({ where: { id: storyboardId } })).document);
    for (const shot of document.shots) shot.asset = { id: asset.id, sha256: asset.sha256 };
    storyboardId = (await manageVideo(scope, { action: "save", storyboardId, document }, () => store)).storyboardId!;
    const board = await db.videoStoryboard.findUniqueOrThrow({ where: { id: storyboardId } });
    for (const shot of storyboardDocument.parse(board.document).shots) await manageVideo(scope, { action: "review-shot", storyboardId, shotId: shot.id, approved: true }, () => store);
    await manageVideo(scope, { action: "approve-storyboard", storyboardId }, () => store);
    await db.workerHeartbeat.upsert({ where: { id: workerId }, create: { id: workerId, runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), executionEnabled: false, motionReady: true }, update: { configurationHash: workerConfigurationHash(), lastSeenAt: new Date() } });
    const renderId = (await manageVideo(scope, { action: "render", storyboardId }, () => store)).renderId!;
    await runOneMotion(async (document, assets) => playable ??= await renderMotion(document, assets), () => store);
    await manageVideo(scope, { action: "approve-render", renderId, continuityReviewed: true }, () => store);
    const render = await db.motionRender.findUniqueOrThrow({ where: { id: renderId } });
    expect(render.bytes).toBeGreaterThanOrEqual(75 * 1024);
    const halfway = Math.floor(render.bytes! / 2);
    f.initialized.value.uploadInstructions[0].lastByte = halfway - 1;
    f.initialized.value.uploadInstructions[1].firstByte = halfway; f.initialized.value.uploadInstructions[1].lastByte = render.bytes! - 1;
    const connection = await saveVerifiedConnection(scope, { provider: "LinkedIn", externalAccountId: f.account.externalAccountId, label: "Synthetic company", token: f.account.token, permissions: [], expiresAt: new Date(Date.now() + 3600000) });
    const action = { action: "schedule", itemId: item.id, version: 1, connectionId: connection.id, scheduledFor: new Date(Date.now() + 120000).toISOString(), timezone: "UTC", videoRenderId: renderId };
    return { ...f, adapter, transfer, scope, item, revision, storyboardId, render, asset, connection, action };
  }
  async function queue(f: Awaited<ReturnType<typeof setup>>) {
    await manageSocial(f.scope, f.action, { LinkedIn: f.adapter });
    const post = await db.socialPublication.findFirstOrThrow({ where: { businessId: f.scope.businessId } });
    f.post.publishedAt = Date.now() + 100;
    await db.socialPublication.update({ where: { id: post.id }, data: { scheduledFor: new Date(Date.now() - 1000) } }); return post;
  }
  it("renders, reviews, uploads private MP4 parts, verifies publication and ingests exact-post organic metrics", async () => {
    const f = await setup(), post = await queue(f); await runOnePublication({ LinkedIn: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", externalPostId: f.id, candidatePostId: f.id, mediaUploaded: true, mediaExternalId: f.videoId, mediaDeliveryTokenHash: null, mediaDeliveryBytes: null });
    const parts = f.fetcher.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(Buffer.concat(parts.map(([, init]) => Buffer.from(init!.body as Uint8Array)))).toEqual(Buffer.from(playable!.bytes));
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
    await db.socialPublication.update({ where: { id: post.id }, data: { nextMetricsAt: new Date(0) } });
    f.replies.push(f.introspection, f.acl, f.post, f.stats, f.post);
    expect(await runOneMetricSync({ LinkedIn: f.adapter })).toBe(true);
    expect(await db.metricSnapshot.findFirstOrThrow({ where: { publicationId: post.id } })).toMatchObject({ impressions: 100, engagements: 6, videoViews: null });
    const dashboard = await readSocialDashboard(f.scope);
    expect(dashboard.publications[0]).toMatchObject({ includesVideo: true, includesImage: false, videoUploadAcknowledged: true });
    for (const secret of [f.account.token, f.render.objectKey, "private-upload-token", "uploadInstructions"]) expect(JSON.stringify(dashboard)).not.toContain(secret);
  }, 60000);
  it("polls acknowledged processing beyond three attempts without repeating upload", async () => {
    const f = await setup(), post = await queue(f); f.video.status = "PROCESSING";
    await runOnePublication({ LinkedIn: f.adapter });
    for (let n = 0; n < 3; n++) {
      expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "SCHEDULED", errorCode: "MEDIA_PROCESSING", submissionAdapterVersion: null });
      await db.socialPublication.update({ where: { id: post.id }, data: { scheduledFor: new Date(0) } });
      f.replies.splice(0, f.replies.length, f.introspection, f.acl, f.video); await runOnePublication({ LinkedIn: f.adapter });
    }
    f.video.status = "AVAILABLE"; f.post.publishedAt = Date.now();
    f.replies.push(f.introspection, f.acl, f.video, new Response(null, { status: 201, headers: { "x-restli-id": f.id } }), f.post);
    await db.socialPublication.update({ where: { id: post.id }, data: { scheduledFor: new Date(0) } }); await runOnePublication({ LinkedIn: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", attempts: 5 });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(2);
  });
  it("bounds processing and allows only explicit pre-post closure", async () => {
    const f = await setup(), post = await queue(f); f.video.status = "PROCESSING"; await runOnePublication({ LinkedIn: f.adapter });
    await db.socialPublication.update({ where: { id: post.id }, data: { scheduledFor: new Date(0), attempts: 14 } });
    f.replies.splice(0, f.replies.length, f.introspection, f.acl, f.video); await runOnePublication({ LinkedIn: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", errorCode: "MEDIA_PROCESSING_REVIEW_REQUIRED" });
    const input = { organizationId: f.scope.organizationId, businessId: f.scope.businessId, publicationId: post.id, operatorId: "local-operator" };
    const preview = await stopUnsubmittedImage(input); expect(preview.mediaKind).toBe("video");
    expect(await stopUnsubmittedImage({ ...input, apply: true, expectedStateHash: preview.stateHash, evidence: "Synthetic test: video processed without any post submission." })).toMatchObject({ status: "FAILED" });
  });
  it("recovers a known post after lost readback without re-uploading", async () => {
    const f = await setup(), post = await queue(f); f.replies[8] = Error("read failed"); await runOnePublication({ LinkedIn: f.adapter });
    expect((await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("NEEDS_RECONCILIATION");
    f.replies.push(f.introspection, f.acl, f.post); await runOneReconciliation({ LinkedIn: f.adapter });
    expect((await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("PUBLISHED");
    expect(f.fetcher.mock.calls.filter(([url]) => String(url) === "https://api.linkedin.com/rest/posts")).toHaveLength(1);
    await expect(stopUnsubmittedImage({ organizationId: f.scope.organizationId, businessId: f.scope.businessId, publicationId: post.id, operatorId: "operator" })).rejects.toThrow();
  });
  it("claims concurrent workers once and preserves URN type constraints", async () => {
    const f = await setup(), post = await queue(f);
    await Promise.all([runOnePublication({ LinkedIn: f.adapter }), runOnePublication({ LinkedIn: f.adapter })]);
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", attempts: 1 });
    await expect(db.socialPublication.update({ where: { id: post.id }, data: { mediaExternalId: "urn:li:image:WRONG" } })).rejects.toThrow();
    await expect(db.socialPublication.update({ where: { id: post.id }, data: { mediaDeliveryTokenHash: "a".repeat(64) } })).rejects.toThrow();
  });
  it.each(["approval", "storyboard", "copy", "brand", "expiry", "bytes", "disabled", "asset permission"])("blocks changed %s before uploading", async kind => {
    const f = await setup(), post = await queue(f);
    if (kind === "approval") await db.motionRender.update({ where: { id: f.render.id }, data: { status: "REJECTED", approvedBy: null } });
    if (kind === "storyboard") await db.videoStoryboard.update({ where: { id: f.storyboardId }, data: { status: "DRAFT" } });
    if (kind === "copy") await db.creativeRevision.update({ where: { id: f.revision.id }, data: { status: "REJECTED" } });
    if (kind === "brand") await db.business.update({ where: { id: f.scope.businessId }, data: { version: { increment: 1 } } });
    if (kind === "expiry") await db.motionRender.update({ where: { id: f.render.id }, data: { purgeAfter: new Date(0) } });
    if (kind === "bytes") objects.set(f.render.objectKey, new Uint8Array([1]));
    if (kind === "asset permission") await db.brandAsset.update({ where: { id: f.asset.id }, data: { approvedForGeneration: false } });
    if (kind === "disabled") vi.stubEnv("LINKEDIN_VIDEO_PUBLISHING_ENABLED", "false");
    await runOnePublication({ LinkedIn: f.adapter });
    expect((await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).status).not.toBe("PUBLISHED");
    expect(f.fetcher.mock.calls.filter(([url, init]) => init?.method && !String(url).endsWith("introspectToken"))).toHaveLength(0);
  });
  it("denies foreign exports, viewers and Instagram-only feed placement", async () => {
    const f = await setup(), other = await setup();
    await expect(manageSocial(f.scope, { ...f.action, videoRenderId: other.render.id }, { LinkedIn: f.adapter })).rejects.toThrow();
    await expect(manageSocial(f.scope, { ...f.action, shareToFeed: false }, { LinkedIn: f.adapter })).rejects.toThrow("Feed placement");
    await db.membership.updateMany({ where: { organizationId: f.scope.organizationId }, data: { role: "VIEWER" } });
    await expect(manageSocial(f.scope, f.action, { LinkedIn: f.adapter })).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
  });
});
