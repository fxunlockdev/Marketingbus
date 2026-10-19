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
import { createInstagramPublishingAdapter } from "../src/lib/social/instagram-publishing";
import { createInstagramDelivery, readInstagramMediaDelivery } from "../src/lib/social/instagram-delivery";
import { submissionJournal } from "../src/lib/social/submission-journal";
import { instagramFixture } from "./helpers/instagram-publishing";
import { readSocialDashboard } from "../src/lib/social/analytics";
import { listPublicationVideos } from "../src/lib/social/video-transfer";
import { stopUnsubmittedImage } from "../src/lib/social/prepost-recovery";
import { resumeMetricChecks } from "../src/lib/social/metric-recovery";

const local = process.env.TEST_DATABASE_URL;
const suite = local ? describe : describe.skip;
if (local && (local !== process.env.DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(local).hostname))) throw Error("Local fixture DB required");
suite("Instagram approved Reel database lifecycle", () => {
  const orgs: string[] = [], users: string[] = [], workerId = `reel-${crypto.randomUUID()}`, objects = new Map<string, Uint8Array>();
  const store: AssetStore = { put: async (k, b) => { objects.set(k, b); }, get: async k => { const b = objects.get(k); if (!b) throw Error("Missing fixture"); return b; }, remove: async k => { objects.delete(k); } };
  let playable: MotionResult | undefined;
  beforeAll(() => {
    vi.stubEnv("SECRET_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") })); vi.stubEnv("SECRET_ENCRYPTION_ACTIVE_KEY", "test");
    for (const key of ["SOCIAL_EXECUTION_ENABLED", "INSTAGRAM_CONNECTIONS_ENABLED", "INSTAGRAM_PUBLISHING_ENABLED", "INSTAGRAM_REELS_ENABLED", "INSTAGRAM_METRICS_ENABLED", "MOTION_RENDERING_ENABLED"]) vi.stubEnv(key, "true");
    vi.stubEnv("MOTION_RENDER_DAILY_LIMIT", "100"); vi.stubEnv("PAID_EXECUTION_ENABLED", "false");
    if (!process.env.TEST_FFMPEG_PATH || !process.env.TEST_FFPROBE_PATH) throw Error("Explicit local FFmpeg tools required for playable Reel verification");
    vi.stubEnv("FFMPEG_PATH", process.env.TEST_FFMPEG_PATH); vi.stubEnv("FFPROBE_PATH", process.env.TEST_FFPROBE_PATH);
  });
  afterEach(async () => {
    vi.stubEnv("INSTAGRAM_REELS_ENABLED", "true");
    await db.socialPublication.deleteMany({ where: { organizationId: { in: orgs } } });
  });
  afterAll(async () => {
    const renders = await db.motionRender.findMany({ where: { organizationId: { in: orgs } } });
    await db.motionAuthorization.deleteMany({ where: { key: { in: renders.map(r => r.id) } } });
    await db.motionRender.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.videoStoryboard.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.user.deleteMany({ where: { id: { in: users } } });
    await db.workerHeartbeat.deleteMany({ where: { id: workerId } }); vi.unstubAllEnvs(); await db.$disconnect();
  });
  async function setup(format = "static") {
    const f = await instagramFixture(), transfer = createImageTransfer(() => store), realDelivery = createInstagramDelivery("https://studio.marketingbus.com");
    let token = "", delivered: Uint8Array | null = null;
    const delivery = { issue: vi.fn(async (...args: Parameters<typeof realDelivery.issue>) => { const url = await realDelivery.issue(...args); token = url.split("/").at(-1)!; return url; }) };
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/media") && init?.method === "POST") {
        const path = new URL(new URLSearchParams(String(init.body)).get("video_url")!).pathname.split("/"), id = path.at(-2)!;
        const metadata = await readInstagramMediaDelivery(id, token, () => store, true);
        expect(metadata.contentType).toBe("video/mp4"); expect(metadata.bytes).toBeNull();
        delivered = (await readInstagramMediaDelivery(id, token, () => store)).bytes;
        expect(delivered?.length).toBe(metadata.length);
      }
      return f.fetcher(url, init);
    });
    const adapter = createInstagramPublishingAdapter(f.config, fetcher, submissionJournal, transfer, delivery);
    const user = await db.user.create({ data: { email: `reel-${crypto.randomUUID()}@example.test`, name: "Local Reel fixture", passwordHash: "not-for-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "REEL TEST ONLY", memberships: { create: { userId: user.id, role: "OWNER" } } } }); orgs.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Design studio", offering: "Design consultations", confirmedAt: new Date() } });
    const scope = { businessId: business.id, organizationId: org.id, actorId: user.id };
    const plan = await db.productionPlan.create({ data: { organizationId: org.id, businessId: business.id, brandVersion: 1, title: "Local Reel", creditCeiling: 0, items: { create: { title: "Design", channel: "Instagram", format, brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: { headline: "Considered spaces", caption: f.payload.caption, cta: "Meet us", visualDirection: "Approved typography", rationale: "Synthetic test", evidenceUsed: [] } } } } } }, include: { items: { include: { revisions: true } } } });
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
    const connection = await saveVerifiedConnection(scope, { provider: "Instagram", externalAccountId: f.account.externalAccountId, label: "Synthetic account", token: f.account.token, permissions: [], expiresAt: new Date(Date.now() + 3600000) });
    f.post.media_type = "VIDEO"; f.post.media_product_type = "REELS";
    const action = { action: "schedule", itemId: item.id, version: 1, connectionId: connection.id, scheduledFor: new Date(Date.now() + 120000).toISOString(), timezone: "UTC", videoRenderId: renderId, shareToFeed: false };
    return { ...f, adapter, fetcher, delivery, scope, item, revision, storyboardId, render, connection, action, token: () => token, delivered: () => delivered };
  }
  async function queue(f: Awaited<ReturnType<typeof setup>>) {
    await manageSocial(f.scope, f.action, { Instagram: f.adapter });
    const post = await db.socialPublication.findFirstOrThrow({ where: { businessId: f.scope.businessId } });
    f.post.timestamp = new Date(Date.now() + 100).toISOString();
    await db.socialPublication.update({ where: { id: post.id }, data: { scheduledFor: new Date(Date.now() - 1000) } }); return post;
  }
  async function processing() {
    const f = await setup(), post = await queue(f); f.ready.status_code = "IN_PROGRESS";
    await runOnePublication({ Instagram: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "SCHEDULED", mediaUploaded: true, mediaExternalId: f.containerId, mediaDeliveryReads: 2, errorCode: "MEDIA_PROCESSING", submissionAdapterVersion: null });
    return { f, post };
  }
  it("renders, reviews, privately delivers and verifies a playable Reel without credits or fabricated metrics", async () => {
    const f = await setup(), post = await queue(f); await runOnePublication({ Instagram: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", externalPostId: f.id, candidatePostId: f.id, mediaUploaded: true, nextMetricsAt: null });
    expect(f.delivered()).toEqual(playable!.bytes);
    await expect(readInstagramMediaDelivery(post.id, f.token(), () => store)).rejects.toThrow();
    expect(await runOneMetricSync({ Instagram: f.adapter })).toBe(false);
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
    const dashboard = await readSocialDashboard(f.scope);
    expect(dashboard.publications[0]).toMatchObject({ includesVideo: true, includesImage: false, videoUploadAcknowledged: true });
    for (const secret of ["mediaDelivery", f.token(), f.account.token, f.render.objectKey]) expect(JSON.stringify(dashboard)).not.toContain(secret);
    expect(await listPublicationVideos(f.scope)).toEqual([expect.objectContaining({ id: f.render.id, itemId: f.item.id, revisionVersion: 1 })]);
    const session = await db.session.create({ data: { id: crypto.randomUUID(), userId: f.scope.actorId, expiresAt: new Date(Date.now() + 60000) } });
    await expect(resumeMetricChecks({ ...f.scope, sessionId: session.id }, { publicationId: post.id, expectedRequestedAt: null }, () => ({ Instagram: f.adapter }))).rejects.toThrow("snapshot");
  }, 60000);
  it("allows more than three processing reads but makes exactly one container and one post", async () => {
    const { f, post } = await processing();
    for (let n = 0; n < 3; n++) {
      f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.identity, f.ready);
      await db.socialPublication.update({ where: { id: post.id }, data: { scheduledFor: new Date(0) } }); await runOnePublication({ Instagram: f.adapter });
    }
    f.ready.status_code = "FINISHED"; f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.identity, f.ready, { id: f.id }, f.post);
    await db.socialPublication.update({ where: { id: post.id }, data: { scheduledFor: new Date(0) } }); await runOnePublication({ Instagram: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", attempts: 5, nextMetricsAt: null });
    expect(f.delivery.issue).toHaveBeenCalledOnce(); expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });
  it.each(["motion", "video"])("publishes approved final media from %s planned work", async format => {
    const f = await setup(format), post = await queue(f); await runOnePublication({ Instagram: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", payload: { format: "video", mediaExportId: f.render.id } });
  });
  it.each(["limit", "expired"])("holds %s processing for explicit pre-post review", async kind => {
    const { f, post } = await processing();
    await db.socialPublication.update({ where: { id: post.id }, data: { scheduledFor: new Date(0), ...(kind === "limit" ? { attempts: 14 } : { mediaDeliveryExpiresAt: new Date(0) }) } });
    f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.identity, f.ready); await runOnePublication({ Instagram: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", errorCode: "MEDIA_PROCESSING_REVIEW_REQUIRED" });
    const request = { organizationId: f.scope.organizationId, businessId: f.scope.businessId, publicationId: post.id, operatorId: "local-test-operator" };
    const preview = await stopUnsubmittedImage(request); expect(preview.mediaKind).toBe("reel");
    expect(await stopUnsubmittedImage({ ...request, apply: true, expectedStateHash: preview.stateHash, evidence: "Local fixture: no post-submission fence exists." })).toMatchObject({ applied: true, status: "FAILED" });
  });
  it.each(["approval", "storyboard", "shot review", "copy", "brand", "expiry", "disabled", "reconnected", "corrupt bytes"])("revokes delivery when %s changes", async kind => {
    const { f, post } = await processing();
    if (kind === "approval") await db.motionRender.update({ where: { id: f.render.id }, data: { status: "REJECTED", approvedBy: null } });
    if (kind === "storyboard") await db.videoStoryboard.update({ where: { id: f.storyboardId }, data: { status: "DRAFT" } });
    if (kind === "shot review") await db.videoStoryboard.update({ where: { id: f.storyboardId }, data: { shotApprovals: [] } });
    if (kind === "copy") await db.creativeRevision.update({ where: { id: f.revision.id }, data: { status: "REJECTED" } });
    if (kind === "brand") await db.business.update({ where: { id: f.scope.businessId }, data: { version: { increment: 1 } } });
    if (kind === "expiry") await db.motionRender.update({ where: { id: f.render.id }, data: { purgeAfter: new Date(0) } });
    if (kind === "disabled") vi.stubEnv("INSTAGRAM_REELS_ENABLED", "false");
    if (kind === "reconnected") await db.socialConnection.update({ where: { id: f.connection.id }, data: { authorizationVersion: { increment: 1 } } });
    if (kind === "corrupt bytes") objects.set(f.render.objectKey, new Uint8Array([1]));
    await expect(readInstagramMediaDelivery(post.id, f.token(), () => store)).rejects.toThrow();
  });
  it("checks approval again after private storage I/O and bounds HEAD reads", async () => {
    const { f, post } = await processing();
    const raced = { ...store, get: async (key: string) => { await db.motionRender.update({ where: { id: f.render.id }, data: { status: "REJECTED" } }); return store.get(key); } };
    await expect(readInstagramMediaDelivery(post.id, f.token(), () => raced)).rejects.toThrow();
    const next = await processing(), read = vi.fn(store.get);
    for (let n = 0; n < 10; n++) await readInstagramMediaDelivery(next.post.id, next.f.token(), () => ({ ...store, get: read }), true);
    expect(read).not.toHaveBeenCalled();
    await expect(readInstagramMediaDelivery(next.post.id, next.f.token(), () => store, true)).rejects.toThrow();
  });
  it("rejects cross-tenant render IDs and capability reuse", async () => {
    const { f, post } = await processing(), other = await setup();
    await expect(manageSocial(other.scope, { ...other.action, videoRenderId: f.render.id }, { Instagram: other.adapter })).rejects.toThrow();
    const otherPost = await queue(other);
    await expect(readInstagramMediaDelivery(otherPost.id, f.token(), () => store)).rejects.toThrow();
    await expect(readInstagramMediaDelivery(post.id, "b".repeat(64), () => store)).rejects.toThrow();
  });
  it("reconciles a known Reel after lost readback without scheduling image metrics", async () => {
    const f = await setup(), post = await queue(f); f.replies[5] = Error("lost readback");
    await runOnePublication({ Instagram: f.adapter });
    expect((await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("NEEDS_RECONCILIATION");
    f.replies.push({ data: f.inspectedPage }, f.identity, f.post); await runOneReconciliation({ Instagram: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", nextMetricsAt: null });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });
});
