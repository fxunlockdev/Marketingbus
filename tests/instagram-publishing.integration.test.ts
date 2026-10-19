import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { db } from "../src/lib/db";
import type { AssetStore } from "../src/lib/assets/storage";
import { manageComposition } from "../src/lib/composition/service";
import { archiveCompositionExport, saveCompositionExport } from "../src/lib/composition/exports";
import { manageSocial, saveVerifiedConnection } from "../src/lib/social/service";
import { runOnePublication, runOneReconciliation, runOneMetricSync } from "../src/lib/social/worker";
import { createImageTransfer } from "../src/lib/social/image-transfer";
import { createInstagramPublishingAdapter } from "../src/lib/social/instagram-publishing";
import { createInstagramDelivery, readInstagramDelivery } from "../src/lib/social/instagram-delivery";
import { fingerprint } from "../src/lib/social/instagram-jpeg";
import { instagramFixture } from "./helpers/instagram-publishing";
import { submissionJournal } from "../src/lib/social/submission-journal";
import { readSocialDashboard } from "../src/lib/social/analytics";
import { stopUnsubmittedImage } from "../src/lib/social/prepost-recovery";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["127.0.0.1", "localhost"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local test DB required");
suite("Instagram durable image publication and revocable delivery", () => {
  const organizations: string[] = [], users: string[] = [], objects = new Map<string, Uint8Array>();
  const store: AssetStore = { put: async (k, b) => { objects.set(k, b); }, get: async k => { const b = objects.get(k); if (!b) throw Error("Missing fixture"); return b; }, remove: async k => { objects.delete(k); } };
  beforeAll(() => {
    vi.stubEnv("SECRET_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") })); vi.stubEnv("SECRET_ENCRYPTION_ACTIVE_KEY", "test");
    for (const key of ["SOCIAL_EXECUTION_ENABLED", "INSTAGRAM_CONNECTIONS_ENABLED", "INSTAGRAM_PUBLISHING_ENABLED"]) vi.stubEnv(key, "true");
  });
  afterEach(async () => { vi.stubEnv("INSTAGRAM_METRICS_ENABLED", "false"); await db.socialPublication.deleteMany({ where: { organizationId: { in: organizations } } }); });
  afterAll(async () => {
    await db.compositionExport.deleteMany({ where: { organizationId: { in: organizations } } });
    await db.organization.deleteMany({ where: { id: { in: organizations } } }); await db.user.deleteMany({ where: { id: { in: users } } });
    vi.unstubAllEnvs(); await db.$disconnect();
  });
  async function setup(placement: "square" | "landscape" = "square") {
    const f = await instagramFixture(), transfer = createImageTransfer(() => store), realDelivery = createInstagramDelivery("https://studio.marketingbus.com");
    let deliveryUrl = "", delivered: Uint8Array | undefined;
    const delivery = { issue: vi.fn(async (...args: Parameters<typeof realDelivery.issue>) => { deliveryUrl = await realDelivery.issue(...args); return deliveryUrl; }) };
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/media") && init?.method === "POST") {
        const incoming = new URL(new URLSearchParams(String(init.body)).get("image_url")!);
        const [id, token] = incoming.pathname.split("/").slice(-2);
        delivered = await readInstagramDelivery(id, token, () => store);
      }
      return f.fetcher(url, init);
    });
    const adapter = createInstagramPublishingAdapter(f.config, fetcher, submissionJournal, transfer, delivery);
    const user = await db.user.create({ data: { email: `instagram-image-${crypto.randomUUID()}@example.test`, name: "Local image fixture", passwordHash: "not-for-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "INSTAGRAM IMAGE TEST ONLY", memberships: { create: { userId: user.id, role: "OWNER" } } } }); organizations.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Design studio", confirmedAt: new Date() } });
    const scope = { businessId: business.id, organizationId: org.id, actorId: user.id };
    const creative = { headline: f.payload.image!.altText, caption: f.payload.caption, cta: "Meet us", visualDirection: "Approved typography", rationale: "Synthetic test only", evidenceUsed: [] };
    const plan = await db.productionPlan.create({ data: { organizationId: org.id, businessId: business.id, brandVersion: 1, title: "Local Instagram image", creditCeiling: 0, items: { create: { title: "Design", channel: "Instagram", format: "static", brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: creative } } } } }, include: { items: { include: { revisions: true } } } });
    const item = plan.items[0], revision = item.revisions[0];
    const c = await manageComposition(scope, { action: "create", itemId: item.id, revisionVersion: 1 });
    await manageComposition(scope, { action: "approve", itemId: item.id, version: 1, rendererVersion: "static-outlines-v2" });
    const saved = await saveCompositionExport(scope, c.composition.id, placement, store);
    const exported = await db.compositionExport.findUniqueOrThrow({ where: { id: saved.id } });
    const connection = await saveVerifiedConnection(scope, { provider: "Instagram", externalAccountId: f.account.externalAccountId, label: "Synthetic Professional account", token: f.account.token, permissions: [], expiresAt: new Date(Date.now() + 3600000) });
    const action = { action: "schedule", itemId: item.id, version: 1, connectionId: connection.id, scheduledFor: new Date(Date.now() + 120000).toISOString(), timezone: "UTC", mediaExportId: saved.id };
    return { ...f, adapter, transfer, fetcher, delivery, scope, item, revision, composition: c.composition, exported, connection, action, getToken: () => deliveryUrl.split("/").at(-1)!, getDelivered: () => delivered! };
  }
  async function queue(f: Awaited<ReturnType<typeof setup>>) {
    await manageSocial(f.scope, f.action, { Instagram: f.adapter });
    const post = await db.socialPublication.findFirstOrThrow({ where: { businessId: f.scope.businessId } }); f.post.timestamp = new Date(Date.now() + 100).toISOString();
    await db.socialPublication.update({ where: { id: post.id }, data: { scheduledFor: new Date(Date.now() - 1000) } }); return post;
  }
  async function processing() {
    const f = await setup(), post = await queue(f); f.ready.status_code = "IN_PROGRESS";
    await runOnePublication({ Instagram: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "SCHEDULED", mediaExternalId: f.containerId, mediaUploaded: true, mediaDeliveryReads: 1, submissionAdapterVersion: null });
    return { f, post };
  }
  it("renders approved content, delivers bounded JPEG, publishes and retires the capability", async () => {
    const f = await setup(), post = await queue(f); await runOnePublication({ Instagram: f.adapter });
    const saved = await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved).toMatchObject({ status: "PUBLISHED", externalPostId: f.id, candidatePostId: f.id, mediaExternalId: f.containerId, mediaUploaded: true, mediaDeliveryReads: 1, nextMetricsAt: null });
    expect(saved.mediaDeliveryTokenHash).not.toBe(f.getToken()); expect(saved.mediaDeliverySha256).toBe(fingerprint(f.getDelivered()));
    expect(await sharp(f.getDelivered()).metadata()).toMatchObject({ format: "jpeg", width: 1080, height: 1080 });
    await expect(readInstagramDelivery(post.id, f.getToken(), () => store)).rejects.toThrow();
    expect(await runOneMetricSync({ Instagram: f.adapter })).toBe(false);
    const safe = JSON.stringify(await readSocialDashboard(f.scope));
    for (const secret of ["mediaDelivery", f.getToken(), f.account.token, f.exported.objectKey]) expect(safe).not.toContain(secret);
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
  });
  it("resumes a processing container, with no second grant or container", async () => {
    const { f, post } = await processing();
    f.ready.status_code = "FINISHED"; f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.identity, f.ready, { id: f.id }, f.post);
    await db.socialPublication.update({ where: { id: post.id }, data: { scheduledFor: new Date(Date.now() - 1000) } });
    await runOnePublication({ Instagram: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", attempts: 2 });
    expect(f.delivery.issue).toHaveBeenCalledOnce(); expect(f.fetcher.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(2);
  });
  async function metricFixture() {
    vi.stubEnv("INSTAGRAM_METRICS_ENABLED", "true");
    const f = await setup(), post = await queue(f); await runOnePublication({ Instagram: f.adapter });
    expect((await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).nextMetricsAt).toBeInstanceOf(Date);
    const publishedAt = new Date(Date.now() - 3600000); f.post.timestamp = publishedAt.toISOString();
    await db.socialPublication.update({ where: { id: post.id }, data: { publishedAt, nextMetricsAt: new Date(Date.now() - 1000) } });
    const stats = { data: ["views", "reach", "total_interactions"].map((name, i) => ({ id: `${f.id}/insights/${name}/lifetime`, name, period: "lifetime", values: [{ value: [1200, 800, 72][i] }] })) };
    f.replies.push({ data: f.inspectedPage }, f.identity, f.post, stats, f.post);
    return { f, post, stats };
  }
  it("ingests native Instagram snapshots once, reports coverage and never spends credits", async () => {
    const { f, post } = await metricFixture();
    expect(await runOneMetricSync({ Instagram: f.adapter })).toBe(true);
    expect(await db.metricSnapshot.findFirstOrThrow({ where: { publicationId: post.id } })).toMatchObject({ organizationId: f.scope.organizationId, businessId: f.scope.businessId, views: 1200, reach: 800, engagements: 72, impressions: null, videoViews: null, clicks: null });
    const summary = (await readSocialDashboard(f.scope)).summary[0];
    expect(summary.metrics.views).toEqual({ value: 1200, coveredPosts: 1 }); expect(summary.metrics.impressions.value).toBeNull(); expect(summary.note).toContain("not impressions");
    const calls = f.fetcher.mock.calls.length; expect(await runOneMetricSync({ Instagram: f.adapter })).toBe(false); expect(f.fetcher).toHaveBeenCalledTimes(calls);
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
    await expect(db.metricSnapshot.updateMany({ where: { publicationId: post.id }, data: { views: -1 } })).rejects.toThrow();
    expect((await readSocialDashboard({ ...f.scope, organizationId: (await setup()).scope.organizationId })).summary).toEqual([]);
  });
  it("invalidates edited Instagram evidence, preserving the receipt and historical snapshots", async () => {
    const { f, post } = await metricFixture(); await runOneMetricSync({ Instagram: f.adapter });
    await db.socialPublication.update({ where: { id: post.id }, data: { nextMetricsAt: new Date(Date.now() - 1000) } });
    f.replies.push({ data: f.inspectedPage }, f.identity, { ...f.post, caption: "Externally edited" });
    await runOneMetricSync({ Instagram: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", externalPostId: f.id, nextMetricsAt: null, metricsLeaseUntil: null, errorCode: "METRICS_SOURCE_CHANGED", metricsInvalidatedAt: expect.any(Date) });
    expect(await db.metricSnapshot.count({ where: { publicationId: post.id } })).toBe(1);
    expect((await readSocialDashboard(f.scope)).summary[0].metrics.views.value).toBeNull();
    await expect(db.socialPublication.update({ where: { id: post.id }, data: { nextMetricsAt: new Date() } })).rejects.toThrow();
  });
  it.each(["failure", "unavailable", "legacy", "reel definition"])("preserves %s as unknown instead of zero or trusted learning", async kind => {
    const { f, post, stats } = await metricFixture();
    if (kind === "failure") f.replies[3] = new Response("private upstream", { status: 403 });
    if (kind === "unavailable") stats.data = [];
    await runOneMetricSync({ Instagram: f.adapter });
    if (kind === "failure") {
      expect(await db.metricSnapshot.count({ where: { publicationId: post.id } })).toBe(0);
      expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ metricsFailures: 1, metricsInvalidatedAt: null, nextMetricsAt: expect.any(Date) });
    } else {
      if (kind === "legacy") await db.metricSnapshot.updateMany({ where: { publicationId: post.id }, data: { definitionVersion: "unverified-legacy" } });
      if (kind === "reel definition") await db.metricSnapshot.updateMany({ where: { publicationId: post.id }, data: { definitionVersion: `instagram-reel-views-reach-total-interactions-${f.config.apiVersion}-v1` } });
      expect((await readSocialDashboard(f.scope)).summary[0].metrics.views.value).toBeNull();
    }
  });
  it.each([false, true])("discards reads across same-token reauthorization; source changed: %s", async changed => {
    const { f, post } = await metricFixture(), original = f.adapter.metrics;
    f.adapter.metrics = async (...args) => {
      const result = await original(...args);
      await db.socialConnection.update({ where: { id: f.connection.id }, data: { authorizationVersion: { increment: 1 } } });
      if (changed) { const { MetricSourceChangedError } = await import("../src/lib/social/contracts"); throw new MetricSourceChangedError(); }
      return result;
    };
    await runOneMetricSync({ Instagram: f.adapter });
    expect(await db.metricSnapshot.count({ where: { publicationId: post.id } })).toBe(0);
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ errorCode: "METRICS_CONTEXT_CHANGED", metricsInvalidatedAt: null, metricsLeaseUntil: null, nextMetricsAt: null });
  });
  it("bounds concurrent delivery reads at exactly 12, including failed read costs", async () => {
    const { f, post } = await processing();
    // Sequential conversions, concurrent reservations: every rejected conversion still consumes its slot.
    const results = await Promise.allSettled(Array.from({ length: 15 }, () => readInstagramDelivery(post.id, f.getToken(), () => store)));
    expect(results.filter(r => r.status === "fulfilled").length).toBeLessThanOrEqual(11);
    for (let n = 0; n < 12; n++) await readInstagramDelivery(post.id, f.getToken(), () => store).catch(() => {});
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ mediaDeliveryReads: 12 });
    await expect(readInstagramDelivery(post.id, f.getToken(), () => store)).rejects.toThrow();
  });
  it.each(["expired", "disconnected", "reauthorized", "approval", "brand", "terminal", "corrupt bytes", "renderer"])("revokes delivery after %s", async kind => {
    const { f, post } = await processing();
    if (kind === "expired") await db.socialPublication.update({ where: { id: post.id }, data: { mediaDeliveryExpiresAt: new Date(0) } });
    if (kind === "disconnected") await db.socialConnection.update({ where: { id: f.connection.id }, data: { status: "DISCONNECTED" } });
    if (kind === "reauthorized") await db.socialConnection.update({ where: { id: f.connection.id }, data: { authorizationVersion: { increment: 1 } } });
    if (kind === "approval") await db.staticComposition.update({ where: { id: f.composition.id }, data: { status: "DRAFT" } });
    if (kind === "brand") await db.business.update({ where: { id: f.scope.businessId }, data: { version: { increment: 1 } } });
    if (kind === "terminal") await db.socialPublication.update({ where: { id: post.id }, data: { status: "CANCELLED" } });
    if (kind === "corrupt bytes") objects.set(f.exported.objectKey, new Uint8Array([1]));
    if (kind === "renderer") await db.socialPublication.update({ where: { id: post.id }, data: { mediaDeliveryVersion: "old-renderer" } });
    await expect(readInstagramDelivery(post.id, f.getToken(), () => store)).rejects.toThrow();
  });
  it("rejects wrong capabilities, cross-publication access and approval races during storage reads", async () => {
    const { f, post } = await processing(), other = await setup(), otherPost = await queue(other);
    await expect(readInstagramDelivery(post.id, "b".repeat(64), () => store)).rejects.toThrow();
    await expect(readInstagramDelivery(otherPost.id, f.getToken(), () => store)).rejects.toThrow();
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ mediaDeliveryReads: 1 });
    const raced = { ...store, get: async (key: string) => { await db.staticComposition.update({ where: { id: f.composition.id }, data: { status: "DRAFT" } }); return store.get(key); } };
    await expect(readInstagramDelivery(post.id, f.getToken(), () => raced)).rejects.toThrow();
  });
  it.each(["landscape", "text", "cross tenant", "viewer", "disabled"])("rejects %s before scheduling or provider calls", async kind => {
    const f = await setup(kind === "landscape" ? "landscape" : "square");
    if (kind === "text") f.action.mediaExportId = "";
    if (kind === "cross tenant") f.action.mediaExportId = (await setup()).exported.id;
    if (kind === "viewer") await db.membership.updateMany({ where: { organizationId: f.scope.organizationId }, data: { role: "VIEWER" } });
    if (kind === "disabled") f.adapter.imagePublishingAvailable = false;
    await expect(manageSocial(f.scope, f.action, { Instagram: f.adapter })).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([2, 4])("holds unknown write %s, revokes delivery and never repeats it", async step => {
    const f = await setup(), post = await queue(f); f.replies[step] = Error("lost response");
    await runOnePublication({ Instagram: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", candidatePostId: null });
    const calls = f.fetcher.mock.calls.length;
    await runOnePublication({ Instagram: f.adapter }); await runOneReconciliation({ Instagram: f.adapter }); expect(f.fetcher).toHaveBeenCalledTimes(calls);
    await expect(readInstagramDelivery(post.id, f.getToken(), () => store)).rejects.toThrow();
    await expect(archiveCompositionExport(f.scope, f.exported.id)).rejects.toThrow("uncertain outcome");
    const input = { ...f.scope, publicationId: post.id, operatorId: "test-operator" }; const { actorId: _actor, ...scoped } = input;
    if (step === 2) {
      const preview = await stopUnsubmittedImage(scoped);
      await stopUnsubmittedImage({ ...scoped, apply: true, expectedStateHash: preview.stateHash, evidence: "Synthetic lost container response before durable post fence." });
      expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "FAILED", errorCode: "PREPOST_IMAGE_STOPPED" });
    } else await expect(stopUnsubmittedImage(scoped)).rejects.toThrow("Never abandon");
  });
  it("recovers a known candidate read-only and survives competing workers", async () => {
    const f = await setup(), post = await queue(f); f.replies[5] = Error("read lost");
    await Promise.all([runOnePublication({ Instagram: f.adapter }), runOnePublication({ Instagram: f.adapter })]);
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", candidatePostId: f.id, attempts: 1 });
    await db.socialConnection.update({ where: { id: f.connection.id }, data: { authorizationVersion: { increment: 1 } } });
    await expect(readInstagramDelivery(post.id, f.getToken(), () => store)).rejects.toThrow();
    f.replies.push({ data: f.inspectedPage }, f.identity, f.post); await runOneReconciliation({ Instagram: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED" });
    expect(f.fetcher.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(2);
  });
  it("enforces complete bounded delivery and provider-specific media journal constraints", async () => {
    const { f, post } = await processing();
    for (const data of [{ mediaDeliveryBytes: null }, { mediaDeliveryReads: 13 }, { mediaDeliveryTokenHash: "raw-token" }, { mediaDeliveryAuthorizationVersion: 0 }, { mediaExternalId: "urn:li:image:INVALID" }, { mediaTransferVersion: null }]) await expect(db.socialPublication.update({ where: { id: post.id }, data })).rejects.toThrow();
    expect(f.fetcher.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(1);
  });
});
