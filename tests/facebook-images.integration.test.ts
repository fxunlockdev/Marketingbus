import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import type { AssetStore } from "../src/lib/assets/storage";
import { manageComposition } from "../src/lib/composition/service";
import { archiveCompositionExport, saveCompositionExport } from "../src/lib/composition/exports";
import { manageSocial, saveVerifiedConnection } from "../src/lib/social/service";
import { runOnePublication, runOneReconciliation, runOneMetricSync, recoverSocialLeases } from "../src/lib/social/worker";
import { createImageTransfer } from "../src/lib/social/image-transfer";
import { createFacebookPublishingAdapter } from "../src/lib/social/facebook-publishing";
import { facebookImageFixture } from "./helpers/facebook-publishing";
import { submissionJournal } from "../src/lib/social/submission-journal";
import { publicationPayload } from "../src/lib/social/contracts";
import { readSocialDashboard } from "../src/lib/social/analytics";
import { stopUnsubmittedImage } from "../src/lib/social/prepost-recovery";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["127.0.0.1", "localhost"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local test DB required");
suite("approved image to Facebook durable publishing", () => {
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
    const transfer = createImageTransfer(() => store), f = facebookImageFixture(submissionJournal, transfer);
    const user = await db.user.create({ data: { email: `facebook-image-${crypto.randomUUID()}@example.test`, name: "Local Facebook fixture", passwordHash: "not-for-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "FACEBOOK IMAGE TEST ONLY", memberships: { create: { userId: user.id, role: "OWNER" } } } }); organizations.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Design studio", confirmedAt: new Date() } });
    const scope = { businessId: business.id, organizationId: org.id, actorId: user.id };
    const creative = { headline: f.payload.image!.altText, caption: f.payload.caption, cta: "Meet us", visualDirection: "Approved typography", rationale: "Synthetic test only", evidenceUsed: [] };
    const plan = await db.productionPlan.create({ data: { organizationId: org.id, businessId: business.id, brandVersion: 1, title: "Local Facebook image", creditCeiling: 0, items: { create: { title: "Design", channel: "Facebook", format: "static", brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: creative } } } } }, include: { items: { include: { revisions: true } } } });
    const item = plan.items[0], revision = item.revisions[0];
    const c = await manageComposition(scope, { action: "create", itemId: item.id, revisionVersion: 1 });
    await manageComposition(scope, { action: "approve", itemId: item.id, version: 1, rendererVersion: "static-outlines-v2" });
    const saved = await saveCompositionExport(scope, c.composition.id, "square", store);
    const exported = await db.compositionExport.findUniqueOrThrow({ where: { id: saved.id } });
    const connection = await saveVerifiedConnection(scope, { provider: "Facebook", externalAccountId: f.account.externalAccountId, label: "Synthetic Page", token: f.account.token, permissions: [], expiresAt: new Date(Date.now() + 3600000) });
    const action = { action: "schedule", itemId: item.id, version: 1, connectionId: connection.id, scheduledFor: new Date(Date.now() + 120000).toISOString(), timezone: "UTC", mediaExportId: saved.id };
    return { ...f, scope, item, revision, composition: c.composition, exported, connection, action };
  }
  async function queue(f: Awaited<ReturnType<typeof setup>>) {
    await manageSocial(f.scope, f.action, { Facebook: f.adapter });
    const post = await db.socialPublication.findFirstOrThrow({ where: { businessId: f.scope.businessId } });
    f.post.created_time = new Date(Date.now() + 100).toISOString();
    await db.socialPublication.update({ where: { id: post.id }, data: { scheduledFor: new Date(Date.now() - 1000) } });
    return post;
  }
  it("renders, selects, transfers exact PNG, verifies photo/post and keeps unknown metrics unavailable", async () => {
    const f = await setup(), post = await queue(f);
    expect(publicationPayload.parse(post.payload)).toMatchObject({ channel: "Facebook", mediaExportId: f.exported.id, image: { sha256: f.exported.sha256, altText: f.photo.alt_text_custom } });
    await runOnePublication({ Facebook: f.adapter });
    const stored = await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } });
    expect(stored).toMatchObject({ status: "PUBLISHED", externalPostId: f.id, candidatePostId: f.id, mediaExternalId: f.imageId, mediaUploaded: true, nextMetricsAt: null });
    const form = f.fetcher.mock.calls[2][1]!.body as FormData;
    expect(Buffer.from(await (form.get("source") as File).arrayBuffer())).toEqual(Buffer.from(objects.get(f.exported.objectKey)!));
    const calls = f.fetcher.mock.calls.length;
    expect(await runOneMetricSync({ Facebook: f.adapter })).toBe(false); expect(f.fetcher).toHaveBeenCalledTimes(calls);
    expect(await db.metricSnapshot.count({ where: { publicationId: post.id } })).toBe(0);
    const safe = JSON.stringify(await readSocialDashboard(f.scope));
    for (const secret of ["mediaTransferVersion", "encryptedToken", f.account.token, f.exported.objectKey]) expect(safe).not.toContain(secret);
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
  });
  it("recovers exact known photo/post IDs with read-only reconciliation", async () => {
    const f = await setup(), post = await queue(f); f.replies[5] = Error("Read lost");
    await runOnePublication({ Facebook: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", candidatePostId: f.id, mediaExternalId: f.imageId, mediaUploaded: true });
    f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.capability, f.post, f.photo);
    await runOneReconciliation({ Facebook: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", externalPostId: f.id, nextMetricsAt: null });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });
  it.each(["upload", "post"])("holds a lost %s response across workers without repeating a write", async kind => {
    const f = await setup(), post = await queue(f); f.replies[kind === "upload" ? 2 : 4] = Error("Lost acknowledgement");
    await runOnePublication({ Facebook: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", candidatePostId: null, mediaExternalId: kind === "post" ? f.imageId : null });
    const calls = f.fetcher.mock.calls.length;
    await runOnePublication({ Facebook: f.adapter }); await runOneReconciliation({ Facebook: f.adapter }); await recoverSocialLeases();
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
    await expect(archiveCompositionExport(f.scope, f.exported.id)).rejects.toThrow("uncertain outcome");
  });
  it.each(["cross tenant", "disabled", "viewer", "unapproved layout", "wrong revision"])("denies %s at scheduling without HTTP", async kind => {
    const f = await setup();
    if (kind === "cross tenant") f.action.mediaExportId = (await setup()).exported.id;
    if (kind === "disabled") f.adapter.imagePublishingAvailable = false;
    if (kind === "viewer") await db.membership.updateMany({ where: { organizationId: f.scope.organizationId }, data: { role: "VIEWER" } });
    if (kind === "unapproved layout") await db.staticComposition.update({ where: { id: f.composition.id }, data: { status: "DRAFT" } });
    if (kind === "wrong revision") { await db.creativeRevision.create({ data: { itemId: f.item.id, organizationId: f.scope.organizationId, version: 2, status: "APPROVED", content: f.revision.content! } }); f.action.version = 2; }
    await expect(manageSocial(f.scope, f.action, { Facebook: f.adapter })).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
    expect(await db.socialPublication.count({ where: { businessId: f.scope.businessId } })).toBe(0);
  });
  it.each(["changed brand", "expired", "disabled", "changed fingerprint"])("cancels %s before any upload", async kind => {
    const f = await setup(), post = await queue(f);
    if (kind === "changed brand") await db.business.update({ where: { id: f.scope.businessId }, data: { confirmedAt: null } });
    if (kind === "expired") await db.compositionExport.update({ where: { id: f.exported.id }, data: { purgeAfter: new Date(0) } });
    if (kind === "disabled") f.adapter.imagePublishingAvailable = false;
    if (kind === "changed fingerprint") await db.compositionExport.update({ where: { id: f.exported.id }, data: { sha256: "b".repeat(64) } });
    await runOnePublication({ Facebook: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "CANCELLED", mediaTransferVersion: null }); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("detects corrupted private bytes before any upload fence or post", async () => {
    const f = await setup(), post = await queue(f); objects.set(f.exported.objectKey, new Uint8Array([1]));
    await runOnePublication({ Facebook: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", mediaTransferVersion: null, submissionAdapterVersion: null });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
  it("retains upload evidence but stops publication if approval changes after upload", async () => {
    const f = await setup(), post = await queue(f), uploaded = f.transfer.uploaded;
    f.transfer.uploaded = async (...args) => { await uploaded(...args); await db.staticComposition.update({ where: { id: f.composition.id }, data: { status: "DRAFT" } }); };
    await runOnePublication({ Facebook: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", mediaExternalId: f.imageId, mediaUploaded: true, submissionAdapterVersion: null });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("enforces provider-specific SQL identity and exactly one upload under competing workers", async () => {
    const f = await setup(), post = await queue(f);
    await expect(db.socialPublication.update({ where: { id: post.id }, data: { mediaTransferVersion: "fixture", mediaExternalId: "urn:li:image:WRONG_PROVIDER" } })).rejects.toThrow();
    await expect(db.socialPublication.update({ where: { id: post.id }, data: { mediaUploaded: true } })).rejects.toThrow();
    await Promise.all([runOnePublication({ Facebook: f.adapter }), runOnePublication({ Facebook: f.adapter })]);
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", attempts: 1 });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });
  it("supports preview-first local recovery before a Facebook post fence, never after", async () => {
    const f = await setup(), post = await queue(f); f.replies[2] = Error("Lost photo response");
    await runOnePublication({ Facebook: f.adapter });
    const input = { organizationId: f.scope.organizationId, businessId: f.scope.businessId, publicationId: post.id, operatorId: "test-operator" };
    const preview = await stopUnsubmittedImage(input);
    expect(preview.applied).toBe(false);
    await stopUnsubmittedImage({ ...input, apply: true, expectedStateHash: preview.stateHash, evidence: "Synthetic photo acknowledgement lost before post submission." });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "FAILED", errorCode: "PREPOST_IMAGE_STOPPED", submissionAdapterVersion: null });
    const g = await setup(), attempted = await queue(g); g.replies[4] = Error("Lost post response");
    await runOnePublication({ Facebook: g.adapter });
    await expect(stopUnsubmittedImage({ ...input, organizationId: g.scope.organizationId, businessId: g.scope.businessId, publicationId: attempted.id })).rejects.toThrow("Never abandon");
  });
});
