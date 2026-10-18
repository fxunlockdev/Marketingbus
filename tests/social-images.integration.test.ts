import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import type { AssetStore } from "../src/lib/assets/storage";
import { manageComposition } from "../src/lib/composition/service";
import { archiveCompositionExport, saveCompositionExport } from "../src/lib/composition/exports";
import { manageSocial, saveVerifiedConnection } from "../src/lib/social/service";
import { runOnePublication, runOneReconciliation, runOneMetricSync } from "../src/lib/social/worker";
import { createImageTransfer, listPublicationImages } from "../src/lib/social/image-transfer";
import { createLinkedInPublishingAdapter } from "../src/lib/social/linkedin-publishing";
import { publishingFixture } from "./helpers/linkedin-publishing";
import { submissionJournal } from "../src/lib/social/submission-journal";
import { publicationPayload } from "../src/lib/social/contracts";
import { payloadHash } from "../src/lib/social/integrity";
import { readSocialDashboard } from "../src/lib/social/analytics";
import { stopUnsubmittedImage } from "../src/lib/social/prepost-recovery";
import sharp from "sharp";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["127.0.0.1", "localhost"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local test DB required");
suite("approved image to LinkedIn publication and metrics", () => {
  const organizations: string[] = [], users: string[] = [], objects = new Map<string, Uint8Array>();
  const store: AssetStore = { put: async (key, bytes) => { objects.set(key, bytes); }, get: async key => { const b = objects.get(key); if (!b) throw Error("Missing image"); return b; }, remove: async key => { objects.delete(key); } };
  beforeAll(() => { vi.stubEnv("SECRET_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") })); vi.stubEnv("SECRET_ENCRYPTION_ACTIVE_KEY", "test"); });
  afterEach(async () => { await db.socialPublication.deleteMany({ where: { organizationId: { in: organizations } } }); });
  afterAll(async () => {
    await db.compositionExport.deleteMany({ where: { organizationId: { in: organizations } } });
    await db.organization.deleteMany({ where: { id: { in: organizations } } }); await db.user.deleteMany({ where: { id: { in: users } } });
    vi.unstubAllEnvs(); await db.$disconnect();
  });
  async function setup() {
    const f = publishingFixture(submissionJournal);
    const user = await db.user.create({ data: { email: `social-image-${crypto.randomUUID()}@example.test`, name: "Image publication fixture", passwordHash: "not-for-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "IMAGE SOCIAL TEST ONLY", memberships: { create: { userId: user.id, role: "OWNER" } } } }); organizations.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Design studio", confirmedAt: new Date() } });
    const scope = { businessId: business.id, organizationId: org.id, actorId: user.id };
    const creative = { headline: "Made for your home", caption: f.payload.caption, cta: "Meet us", visualDirection: "Approved typography", rationale: "Synthetic test only", evidenceUsed: [] };
    const plan = await db.productionPlan.create({ data: { organizationId: org.id, businessId: business.id, brandVersion: 1, title: "Local image flow", creditCeiling: 0, items: { create: { title: "Design", channel: "LinkedIn", format: "static", brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: creative } } } } }, include: { items: { include: { revisions: true } } } });
    const item = plan.items[0], revision = item.revisions[0];
    const c = await manageComposition(scope, { action: "create", itemId: item.id, revisionVersion: 1 });
    await manageComposition(scope, { action: "approve", itemId: item.id, version: 1, rendererVersion: "static-outlines-v2" });
    const saved = await saveCompositionExport(scope, c.composition.id, "square", store);
    const exported = await db.compositionExport.findUniqueOrThrow({ where: { id: saved.id } });
    const connection = await saveVerifiedConnection(scope, { provider: "LinkedIn", externalAccountId: f.account.externalAccountId, label: "Synthetic company", token: f.account.token, permissions: [], expiresAt: new Date(Date.now() + 3600000) });
    const transfer = createImageTransfer(() => store), adapter = createLinkedInPublishingAdapter(f.config, f.fetcher, submissionJournal, { enabled: true, transfer });
    const action = { action: "schedule", itemId: item.id, version: 1, connectionId: connection.id, scheduledFor: new Date(Date.now() + 120000).toISOString(), timezone: "UTC", mediaExportId: saved.id };
    const imageId = "urn:li:image:LOCAL_TEST_123", registration = { value: { image: imageId, uploadUrl: "https://www.linkedin.com/dms-uploads/LOCAL_TEST_123/uploaded-image/0?ut=private", uploadUrlExpiresAt: Date.now() + 3600000 } }, ready = { id: imageId, owner: f.account.externalAccountId, status: "AVAILABLE" };
    const post = { ...f.post, publishedAt: Date.now() + 100, content: { media: { id: imageId, altText: creative.headline } } };
    f.replies.splice(2, 2, registration, new Response(null, { status: 201 }), ready, new Response(null, { status: 201, headers: { "x-restli-id": f.id } }), post);
    return { ...f, adapter, transfer, scope, item, revision, composition: c.composition, exported, connection, action, imageId, registration, ready, post };
  }
  async function queue(f: Awaited<ReturnType<typeof setup>>) {
    await manageSocial(f.scope, f.action, { LinkedIn: f.adapter });
    const post = await db.socialPublication.findFirstOrThrow({ where: { businessId: f.scope.businessId } });
    f.post.publishedAt = Date.now();
    await db.socialPublication.update({ where: { id: post.id }, data: { scheduledFor: new Date(Date.now() - 1000) } });
    return post;
  }
  it("renders approved PNG, schedules its immutable fingerprint, transfers exact bytes, publishes and ingests bound metrics", async () => {
    const f = await setup(), post = await queue(f);
    expect(publicationPayload.parse(post.payload)).toMatchObject({ mediaExportId: f.exported.id, image: { sha256: f.exported.sha256, altText: "Made for your home", width: 1080, height: 1080 } });
    const choices = await listPublicationImages(f.scope); expect(choices).toHaveLength(1); expect(JSON.stringify(choices)).not.toContain("objectKey");
    await runOnePublication({ LinkedIn: f.adapter });
    const stored = await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } });
    expect(stored).toMatchObject({ status: "PUBLISHED", externalPostId: f.id, candidatePostId: f.id, mediaExternalId: f.imageId, mediaUploaded: true });
    const uploaded = f.fetcher.mock.calls.find(([, init]) => init?.method === "PUT")![1]!.body as Uint8Array;
    expect(Buffer.from(uploaded)).toEqual(Buffer.from(objects.get(f.exported.objectKey)!)); expect((await sharp(uploaded).metadata()).format).toBe("png");
    expect(JSON.stringify(await readSocialDashboard(f.scope))).not.toContain("mediaTransferVersion");
    await db.socialPublication.update({ where: { id: post.id }, data: { nextMetricsAt: new Date(Date.now() - 1000) } });
    f.replies.push(f.introspection, f.acl, f.post, f.stats, f.post);
    await runOneMetricSync({ LinkedIn: f.adapter });
    expect(await db.metricSnapshot.findFirst({ where: { publicationId: post.id } })).toMatchObject({ impressions: 100, engagements: 6 });
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
  });
  it("resumes processing using the recorded asset without creating another upload", async () => {
    const f = await setup(), post = await queue(f); f.replies.splice(4, 3, { ...f.ready, status: "PROCESSING" });
    await runOnePublication({ LinkedIn: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "SCHEDULED", mediaUploaded: true, mediaExternalId: f.imageId, submissionAdapterVersion: null });
    await db.socialPublication.update({ where: { id: post.id }, data: { scheduledFor: new Date(Date.now() - 1000) } });
    f.replies.push(f.introspection, f.acl, f.ready, new Response(null, { status: 201, headers: { "x-restli-id": f.id } }), f.post);
    await runOnePublication({ LinkedIn: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", attempts: 2 });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });
  it("keeps unknown post outcomes read-only and recovers the exact image/post receipt", async () => {
    const f = await setup(), post = await queue(f); f.replies[6] = Error("lost response");
    await runOnePublication({ LinkedIn: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", mediaExternalId: f.imageId, candidatePostId: f.id });
    f.replies.push(f.introspection, f.acl, f.post); await runOneReconciliation({ LinkedIn: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED" });
    expect(f.fetcher.mock.calls.filter(([u]) => u === "https://api.linkedin.com/rest/posts")).toHaveLength(1);
  });
  it.each(["cross tenant", "wrong revision", "unapproved layout", "expired", "expiry before schedule", "manifest", "disabled"])("rejects %s at scheduling without network calls", async kind => {
    const f = await setup();
    if (kind === "cross tenant") { const other = await setup(); f.action.mediaExportId = other.exported.id; }
    if (kind === "wrong revision") { const r = await db.creativeRevision.create({ data: { itemId: f.item.id, organizationId: f.scope.organizationId, version: 2, status: "APPROVED", content: f.revision.content! } }); f.action.version = r.version; }
    if (kind === "unapproved layout") await db.staticComposition.update({ where: { id: f.composition.id }, data: { status: "DRAFT" } });
    if (kind === "expired") await db.compositionExport.update({ where: { id: f.exported.id }, data: { purgeAfter: new Date(0) } });
    if (kind === "expiry before schedule") f.action.scheduledFor = new Date(Date.now() + 31 * 86400000).toISOString();
    if (kind === "manifest") await db.compositionExport.update({ where: { id: f.exported.id }, data: { manifest: {} } });
    if (kind === "disabled") f.adapter.imagePublishingAvailable = false;
    await expect(manageSocial(f.scope, f.action, { LinkedIn: f.adapter })).rejects.toThrow();
    expect(await db.socialPublication.count({ where: { businessId: f.scope.businessId } })).toBe(0); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(["expired", "changed fingerprint", "changed brand", "revoked approval", "disabled"])("cancels queued publication when %s before upload", async kind => {
    const f = await setup(), post = await queue(f);
    if (kind === "expired") await db.compositionExport.update({ where: { id: f.exported.id }, data: { purgeAfter: new Date(0) } });
    if (kind === "changed fingerprint") await db.compositionExport.update({ where: { id: f.exported.id }, data: { sha256: "b".repeat(64) } });
    if (kind === "changed brand") await db.business.update({ where: { id: f.scope.businessId }, data: { confirmedAt: null } });
    if (kind === "revoked approval") await db.staticComposition.update({ where: { id: f.composition.id }, data: { status: "DRAFT" } });
    if (kind === "disabled") f.adapter.imagePublishingAvailable = false;
    await runOnePublication({ LinkedIn: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "CANCELLED", mediaTransferVersion: null }); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("checks stored bytes before initialization and sends no corrupted image", async () => {
    const f = await setup(), post = await queue(f); objects.set(f.exported.objectKey, new Uint8Array([9]));
    await runOnePublication({ LinkedIn: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", mediaTransferVersion: null, candidatePostId: null });
    expect(f.fetcher.mock.calls).toHaveLength(2);
  });
  it("archives cancel queued images but cannot race an in-flight or uncertain publication", async () => {
    const f = await setup(), post = await queue(f);
    await archiveCompositionExport(f.scope, f.exported.id);
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "CANCELLED" }); expect(await listPublicationImages(f.scope)).toEqual([]);
    const g = await setup(), active = await queue(g);
    await db.socialPublication.update({ where: { id: active.id }, data: { status: "SUBMITTING", leaseUntil: new Date(Date.now() + 60000) } });
    await expect(archiveCompositionExport(g.scope, g.exported.id)).rejects.toThrow("uncertain outcome");
    expect(await db.compositionExport.findUniqueOrThrow({ where: { id: g.exported.id } })).toMatchObject({ status: "READY" });
  });
  it("rechecks current authority between registration and binary upload", async () => {
    const f = await setup(), post = await queue(f), record = f.transfer.record;
    f.transfer.record = async (...args) => { await record(...args); await db.business.update({ where: { id: f.scope.businessId }, data: { confirmedAt: null } }); };
    await runOnePublication({ LinkedIn: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", mediaExternalId: f.imageId, mediaUploaded: false, submissionAdapterVersion: null });
    expect(f.fetcher.mock.calls.some(([, i]) => i?.method === "PUT")).toBe(false);
  });
  it("requires a complete database image binding and never permits a changed payload on reschedule", async () => {
    const f = await setup(), post = await queue(f);
    await expect(db.socialPublication.update({ where: { id: post.id }, data: { mediaUploaded: true } })).rejects.toThrow();
    await expect(db.socialPublication.update({ where: { id: post.id }, data: { mediaExternalId: "https://evil.example/" } })).rejects.toThrow();
    const text = { ...f.payload, mediaExportId: null };
    await expect(db.socialPublication.update({ where: { id: post.id }, data: { payload: text, payloadHash: payloadHash(text), mediaTransferVersion: "fixture" } })).rejects.toThrow();
    const { mediaExportId: _id, ...withoutImage } = f.action;
    await expect(manageSocial(f.scope, withoutImage, { LinkedIn: f.adapter })).rejects.toThrow("different content");
  });
  async function interruptedImage() {
    const f = await setup(), post = await queue(f);
    const stopped = await db.socialPublication.update({ where: { id: post.id }, data: {
      status: "NEEDS_RECONCILIATION", mediaTransferVersion: "fixture-image-v1", mediaExternalId: f.imageId,
      mediaUploaded: false, leaseUntil: new Date(Date.now() - 1000), errorCode: "IMAGE_UPLOAD_UNKNOWN",
    } });
    const input = { organizationId: f.scope.organizationId, businessId: f.scope.businessId,
      publicationId: post.id, operatorId: "local-fixture-operator" };
    return { ...f, stopped, input };
  }
  it("previews without writes, closes only the local pre-post attempt and releases local retention", async () => {
    const f = await interruptedImage();
    const preview = await stopUnsubmittedImage(f.input);
    expect(preview).toMatchObject({ applied: false, status: "NEEDS_RECONCILIATION", imageRegistered: true, uploadAcknowledged: false });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: f.stopped.id } })).toEqual(f.stopped);
    expect(JSON.stringify(preview)).not.toContain(f.imageId);
    const result = await stopUnsubmittedImage({ ...f.input, apply: true, expectedStateHash: preview.stateHash, evidence: "Reviewed the journal; post submission never began." });
    expect(result).toMatchObject({ applied: true, status: "FAILED" });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: f.stopped.id } })).toMatchObject({
      status: "FAILED", errorCode: "PREPOST_IMAGE_STOPPED", mediaExternalId: f.imageId,
      mediaTransferVersion: "fixture-image-v1", payloadHash: f.stopped.payloadHash, leaseUntil: null,
      submissionAdapterVersion: null, nextReconciliationAt: null,
    });
    expect(await db.auditEvent.count({ where: { businessId: f.scope.businessId, action: "SOCIAL_PREPOST_IMAGE_STOPPED" } })).toBe(1);
    expect(await runOneReconciliation({ LinkedIn: f.adapter })).toBe(false);
    const ctx = { requestId: f.stopped.id, account: { ...f.account, id: f.connection.id }, payload: publicationPayload.parse(f.stopped.payload), adapterVersion: "fixture-image-v1" };
    await expect(submissionJournal.begin(ctx)).rejects.toThrow("context changed");
    await expect(f.transfer.record(ctx, f.imageId)).rejects.toThrow("context changed");
    await expect(manageSocial(f.scope, f.action, { LinkedIn: f.adapter })).rejects.toThrow("already been submitted");
    await archiveCompositionExport(f.scope, f.exported.id);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(["submission fence", "candidate", "receipt", "publication time", "permalink", "active lease", "queued", "submitting", "published", "cancelled", "invalid hash", "text payload"])("refuses unsafe pre-post recovery: %s", async kind => {
    const f = await interruptedImage();
    const data = kind === "submission fence" ? { submissionAdapterVersion: "fixture-image-v1" }
      : kind === "candidate" ? { candidatePostId: f.id, submissionAdapterVersion: "fixture-image-v1" } : kind === "receipt" ? { externalPostId: f.id }
      : kind === "publication time" ? { publishedAt: new Date() } : kind === "permalink" ? { permalink: "https://www.linkedin.com/feed/update/urn:li:share:123" }
      : kind === "active lease" ? { leaseUntil: new Date(Date.now() + 60000) }
      : kind === "invalid hash" ? { payloadHash: "0".repeat(64) }
      : kind === "text payload" ? { payload: f.payload, payloadHash: payloadHash(f.payload), mediaTransferVersion: null, mediaExternalId: null, mediaUploaded: false }
      : kind === "published" ? { status: "PUBLISHED", externalPostId: f.id, publishedAt: new Date() }
      : { status: ({ queued: "SCHEDULED", submitting: "SUBMITTING", published: "PUBLISHED", cancelled: "CANCELLED" } as Record<string, string>)[kind] };
    await db.socialPublication.update({ where: { id: f.stopped.id }, data });
    await expect(stopUnsubmittedImage(f.input)).rejects.toThrow();
    expect(await db.auditEvent.count({ where: { businessId: f.scope.businessId, action: "SOCIAL_PREPOST_IMAGE_STOPPED" } })).toBe(0);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("refuses wrong scopes, missing evidence, changed previews and replay", async () => {
    const f = await interruptedImage(), other = await setup(), preview = await stopUnsubmittedImage(f.input);
    await expect(stopUnsubmittedImage({ ...f.input, organizationId: other.scope.organizationId })).rejects.toThrow();
    await expect(stopUnsubmittedImage({ ...f.input, organizationId: other.scope.organizationId, businessId: other.scope.businessId })).rejects.toThrow();
    await expect(stopUnsubmittedImage({ ...f.input, apply: true, expectedStateHash: preview.stateHash })).rejects.toThrow();
    await db.socialPublication.update({ where: { id: f.stopped.id }, data: { reconciliationAttempts: 1 } });
    await expect(stopUnsubmittedImage({ ...f.input, apply: true, expectedStateHash: preview.stateHash, evidence: "The operator reviewed this synthetic test." })).rejects.toThrow("changed after review");
    const next = await stopUnsubmittedImage(f.input), apply = { ...f.input, apply: true, expectedStateHash: next.stateHash, evidence: "The operator reviewed this synthetic test." };
    const results = await Promise.allSettled([stopUnsubmittedImage(apply), stopUnsubmittedImage(apply)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.auditEvent.count({ where: { businessId: f.scope.businessId, action: "SOCIAL_PREPOST_IMAGE_STOPPED" } })).toBe(1);
  });
  it.each(["no media registration", "acknowledged upload"])("can stop %s without a current credential and without erasing media evidence", async kind => {
    const f = await interruptedImage();
    await db.socialPublication.update({ where: { id: f.stopped.id }, data: kind === "no media registration"
      ? { mediaTransferVersion: null, mediaExternalId: null, mediaUploaded: false }
      : { mediaUploaded: true } });
    await db.socialConnection.update({ where: { id: f.connection.id }, data: { status: "DISCONNECTED", encryptedToken: "" } });
    const preview = await stopUnsubmittedImage(f.input);
    await stopUnsubmittedImage({ ...f.input, apply: true, expectedStateHash: preview.stateHash, evidence: "No post fence; disconnected synthetic account, reviewed by operator." });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: f.stopped.id } })).toMatchObject({
      status: "FAILED", mediaUploaded: kind === "acknowledged upload", mediaExternalId: kind === "acknowledged upload" ? f.imageId : null,
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
