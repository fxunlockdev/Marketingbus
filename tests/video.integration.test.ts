import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { db } from "../src/lib/db";
import { manageVideo, listVideo, readMotion } from "../src/lib/video/service";
import { runOneMotion, recoverMotionLeases, recoverMotionStorage, purgeMotion } from "../src/lib/video/worker";
import { storyboardDocument, totalDuration, DEFAULT_CLIP_EDIT, type StoryboardDocument } from "../src/lib/video/document";
import { WORKER_RUNTIME, workerConfigurationHash } from "../src/lib/production/readiness";
import { uploadAsset, changeAsset } from "../src/lib/assets/service";
import type { AssetStore } from "../src/lib/assets/storage";
import { uploadClip, runOneClip, reviewClip, readClip, recoverClipStorage, recoverClipLeases, purgeClips, listClips } from "../src/lib/video/clips";
import { manageApprovals } from "../src/lib/workflows/approvals";
import { VIDEO_FORMATS, videoLayout } from "../src/lib/video/layout";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local test DB required");
suite("storyboard and motion lifecycle", () => {
  const orgs: string[] = [], users: string[] = [], workerId = `motion-fixture-${crypto.randomUUID()}`, objects = new Map<string, Buffer>();
  const store: AssetStore = { put: async (key, bytes, _mime, immutable) => { if (immutable && objects.has(key)) throw Error("immutable"); objects.set(key, Buffer.from(bytes)); }, get: async key => { const bytes = objects.get(key); if (!bytes) throw Error("missing"); return bytes; }, remove: async key => { objects.delete(key); } };
  beforeEach(async () => {
    vi.stubEnv("MOTION_RENDERING_ENABLED", "true"); vi.stubEnv("MOTION_RENDER_DAILY_LIMIT", "100"); vi.stubEnv("PAID_EXECUTION_ENABLED", "false");
    // Capability is injected as fixture heartbeat only. Actual FFmpeg is tested separately.
    await db.workerHeartbeat.upsert({ where: { id: workerId }, create: { id: workerId, runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), executionEnabled: false, motionReady: true }, update: { runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), motionReady: true, lastSeenAt: new Date() } });
  });
  afterAll(async () => {
    await db.socialPublication.deleteMany({ where: { organizationId: { in: orgs } } });
    const renders = await db.motionRender.findMany({ where: { organizationId: { in: orgs } } });
    const clips = await db.videoClip.findMany({ where: { organizationId: { in: orgs } } });
    await db.motionAuthorization.deleteMany({ where: { key: { in: [...renders, ...clips].map(r => r.id) } } });
    await db.videoClip.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.motionRender.deleteMany({ where: { organizationId: { in: orgs } } }); await db.videoStoryboard.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.brandAsset.deleteMany({ where: { organizationId: { in: orgs } } }); await db.imageGeneration.deleteMany({ where: { organizationId: { in: orgs } } }); await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.user.deleteMany({ where: { id: { in: users } } });
    await db.workerHeartbeat.deleteMany({ where: { id: workerId } }); vi.unstubAllEnvs(); await db.$disconnect();
  });
  async function setup() {
    const user = await db.user.create({ data: { email: `motion-${crypto.randomUUID()}@example.test`, name: "Motion fixture", passwordHash: "no-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "MOTION FIXTURE", wallet: { create: {} }, memberships: { create: { userId: user.id, role: "OWNER" } } } }); orgs.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Design studio", offering: "Architecture consultations", confirmedAt: new Date() } });
    const plan = await db.productionPlan.create({ data: { businessId: business.id, organizationId: org.id, brandVersion: 1, title: "Motion plan", creditCeiling: 0, items: { create: { title: "Considered spaces", format: "motion", channel: "YouTube", brief: {} } } }, include: { items: true } });
    const scope = { organizationId: org.id, businessId: business.id, actorId: user.id };
    const created = await manageVideo(scope, { action: "create", itemId: plan.items[0].id }, () => store);
    return { scope, item: plan.items[0], id: created.storyboardId!, renderer: vi.fn(async (document: StoryboardDocument, _assets?: Map<string, Uint8Array>) => ({ bytes: Buffer.from("controlled renderer fixture, not playable media"), durationMs: totalDuration(document), width: 720, height: 1280 })) };
  }
  async function board(id: string) { return db.videoStoryboard.findUniqueOrThrow({ where: { id } }); }
  async function row(id: string) { return db.motionRender.findUniqueOrThrow({ where: { id } }); }
  async function approve(f: Awaited<ReturnType<typeof setup>>, id = f.id) {
    const document = storyboardDocument.parse((await board(id)).document);
    for (const shot of document.shots) await manageVideo(f.scope, { action: "review-shot", storyboardId: id, shotId: shot.id, approved: true }, () => store);
    await manageVideo(f.scope, { action: "approve-storyboard", storyboardId: id }, () => store);
  }
  async function queue(f: Awaited<ReturnType<typeof setup>>, id = f.id) {
    await approve(f, id); const result = await manageVideo(f.scope, { action: "render", storyboardId: id }, () => store); return result.renderId!;
  }
  it("repeating final video approval preserves other scheduled work and its original audit", async () => {
    const f = await setup(), id = await queue(f); await runOneMotion(f.renderer, () => store);
    const action = { action: "approve-render", renderId: id, continuityReviewed: true };
    await manageVideo(f.scope, action, () => store);
    const item = await db.productionItem.create({ data: { planId: f.item.planId, organizationId: f.scope.organizationId, title: "Other scheduled post", format: "static", channel: "Facebook", brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: {} } } }, include: { revisions: true } });
    const connection = await db.socialConnection.create({ data: { businessId: f.scope.businessId, organizationId: f.scope.organizationId, provider: "Facebook", externalAccountId: "fixture", label: "Fixture", encryptedToken: "no-live-token", permissions: [] } });
    const post = await db.socialPublication.create({ data: { businessId: f.scope.businessId, organizationId: f.scope.organizationId, connectionId: connection.id, revisionId: item.revisions[0].id, brandVersion: 1, payload: {}, payloadHash: "a".repeat(64), scheduledFor: new Date(Date.now() + 60000), timezone: "UTC" } });
    await Promise.all([manageVideo(f.scope, action, () => store), manageVideo(f.scope, action, () => store)]);
    expect((await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("SCHEDULED");
    expect(await db.auditEvent.count({ where: { businessId: f.scope.businessId, action: "MOTION_REVIEW" } })).toBe(1);
    await expect(manageVideo(f.scope, { ...action, continuityReviewed: false }, () => store)).rejects.toThrow("Watch");
  });
  it.each(VIDEO_FORMATS)("binds %s exports to the exact format and final review without AI charges", async format => {
    const f = await setup(), document = { ...storyboardDocument.parse((await board(f.id)).document), format };
    const next = (await manageVideo(f.scope, { action: "save", storyboardId: f.id, document }, () => store)).storyboardId!;
    const id = await queue(f, next), l = videoLayout(document);
    await runOneMotion(async d => ({ bytes: Buffer.from(`format-fixture-${d.format}`), durationMs: totalDuration(d), width: l.width, height: l.height }), () => store);
    expect((await row(id)).status).toBe("READY"); await expect(readMotion(f.scope, id, true, store)).rejects.toThrow("approval");
    await manageVideo(f.scope, { action: "approve-render", renderId: id, continuityReviewed: true }, () => store);
    expect((await readMotion(f.scope, id, true, store)).document.format).toBe(format);
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
  });
  it("changing format clears every shot review, cancels queued output and preserves old bytes", async () => {
    const f = await setup(), id = await queue(f); await runOneMotion(f.renderer, () => store);
    await manageVideo(f.scope, { action: "approve-render", renderId: id, continuityReviewed: true }, () => store);
    const old = await row(id), oldBytes = Buffer.from(objects.get(old.objectKey)!);
    const document = { ...storyboardDocument.parse((await board(f.id)).document), format: "square" };
    const next = (await manageVideo(f.scope, { action: "save", storyboardId: f.id, document }, () => store)).storyboardId!;
    expect((await board(next)).shotApprovals).toEqual([]);
    await expect(manageVideo(f.scope, { action: "approve-storyboard", storyboardId: next }, () => store)).rejects.toThrow("every current shot");
    await expect(readMotion(f.scope, id, true, store)).rejects.toThrow("changed"); expect(objects.get(old.objectKey)).toEqual(oldBytes);
    const queued = await queue(f, next);
    await manageVideo(f.scope, { action: "save", storyboardId: next, document: { ...document, format: "landscape" } }, () => store);
    expect((await row(queued)).status).toBe("CANCELLED");
  });
  it.each(["wrong-dimensions", "nonfinite-duration", "changed-during-render"])("rejects %s before private format output is stored", async reason => {
    const f = await setup(), document = { ...storyboardDocument.parse((await board(f.id)).document), format: "square" as const };
    const next = (await manageVideo(f.scope, { action: "save", storyboardId: f.id, document }, () => store)).storyboardId!, id = await queue(f, next);
    const put = vi.fn(store.put);
    await runOneMotion(async d => {
      if (reason === "changed-during-render") await db.videoStoryboard.update({ where: { id: next }, data: { document: { ...document, format: "feed" } } });
      return { bytes: Buffer.from("must not store"), width: 720, height: reason === "wrong-dimensions" ? 1280 : 720, durationMs: reason === "nonfinite-duration" ? NaN : totalDuration(d) };
    }, () => ({ ...store, put }));
    expect(put).not.toHaveBeenCalled(); expect((await row(id)).status).toBe("FAILED");
  });
  it("rejects unknown format/overflow without creating a version and allows repairing an overflowing draft", async () => {
    const f = await setup(), document = storyboardDocument.parse((await board(f.id)).document);
    await expect(manageVideo(f.scope, { action: "save", storyboardId: f.id, document: { ...document, format: "custom-filter" } }, () => store)).rejects.toThrow();
    const bad = { ...document, format: "square", shots: document.shots.map((s, i) => i === 0 ? { ...s, caption: "W".repeat(100) } : s) };
    await expect(manageVideo(f.scope, { action: "save", storyboardId: f.id, document: bad }, () => store)).rejects.toThrow("does not fit");
    expect(await db.videoStoryboard.count({ where: { businessId: f.scope.businessId } })).toBe(1); expect((await board(f.id)).status).toBe("DRAFT");
    await db.videoStoryboard.update({ where: { id: f.id }, data: { document: bad } });
    await expect(approve(f)).rejects.toThrow("does not fit");
    expect((await manageVideo(f.scope, { action: "save", storyboardId: f.id, document }, () => store)).storyboardId).toBeTruthy();
  });
  async function artwork(f: Awaited<ReturnType<typeof setup>>) {
    const { organizationId, businessId, actorId } = f.scope;
    // Different planned creative, same confirmed business: reuse is explicit.
    const item = await db.productionItem.create({ data: { organizationId, planId: f.item.planId, title: "Supporting artwork", format: "static", channel: "Instagram", brief: {}, revisions: { create: { version: 1, status: "APPROVED", authorId: actorId, approvedBy: actorId, content: {} } } }, include: { revisions: true } });
    const generation = await db.imageGeneration.create({ data: { businessId, organizationId, actorId, itemId: item.id, revisionId: item.revisions[0].id, brandVersion: 1, version: 1, prompt: "local fixture only", references: [], route: {}, configurationHash: "fixture", credits: 1, supplierCeilingMicros: 1, expiresAt: new Date(), acceptedAt: new Date(), status: "APPROVED", approvedBy: actorId } });
    const bytes = await sharp({ create: { width: 40, height: 40, channels: 4, background: "#237456" } }).webp().toBuffer();
    const asset = await db.brandAsset.create({ data: { businessId, organizationId, generationId: generation.id, objectKey: `fixture/${crypto.randomUUID()}`, purpose: "generated", label: "Approved scene artwork", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, width: 40, height: 40, status: "READY", approvedForGeneration: true, uploadedBy: actorId, rightsConfirmedAt: new Date() } }); objects.set(asset.objectKey, bytes);
    return { asset, generation, item, bytes };
  }
  async function useArtwork(f: Awaited<ReturnType<typeof setup>>, asset: { id: string; sha256: string }) {
    const document = storyboardDocument.parse((await board(f.id)).document); document.shots[0].asset = { id: asset.id, sha256: asset.sha256 };
    return (await manageVideo(f.scope, { action: "save", storyboardId: f.id, document }, () => store)).storyboardId!;
  }
  const source = Buffer.from("000000186674797069736f6d0000020069736f6d6d703432", "hex");
  const processed = { bytes: Buffer.from("fixture-only-normalized-output"), durationMs: 6000 };
  async function upload(f: Awaited<ReturnType<typeof setup>>) { return (await uploadClip(f.scope, { label: "Studio footage", rightsConfirmed: true }, source, store)).clipId; }
  async function readyClip(f: Awaited<ReturnType<typeof setup>>) {
    const id = await upload(f); await runOneClip(async () => processed, () => store); return db.videoClip.findUniqueOrThrow({ where: { id } });
  }
  async function useClip(f: Awaited<ReturnType<typeof setup>>, clip: { id: string; sha256: string }) {
    const document = storyboardDocument.parse((await board(f.id)).document); document.shots[0].clip = { id: clip.id, sha256: clip.sha256 };
    return (await manageVideo(f.scope, { action: "save", storyboardId: f.id, document }, () => store)).storyboardId!;
  }
  it("quarantines raw clips, reviews normalized bytes, renders mixed scenes and revokes dependent approvals", async () => {
    const f = await setup(), id = await upload(f);
    await expect(readClip(f.scope, id, store)).rejects.toThrow("processed");
    const process = vi.fn(async () => processed); await runOneClip(process, () => store); await runOneClip(process, () => store); expect(process).toHaveBeenCalledOnce();
    const clip = await db.videoClip.findUniqueOrThrow({ where: { id } }); expect(clip.status).toBe("READY");
    expect(await readClip(f.scope, id, store)).toEqual(processed.bytes);
    await expect(useClip(f, clip)).rejects.toThrow("unavailable");
    await expect(reviewClip(f.scope, id, { action: "approve" })).rejects.toThrow("Watch");
    await reviewClip(f.scope, id, { action: "approve", watched: true });
    const storyboardId = await useClip(f, clip), renderId = await queue(f, storyboardId); await runOneMotion(f.renderer, () => store);
    expect(f.renderer.mock.calls[0][1]?.get(id)).toEqual(processed.bytes);
    await manageVideo(f.scope, { action: "approve-render", renderId, continuityReviewed: true }, () => store);
    expect((await readMotion(f.scope, renderId, true, store)).bytes.length).toBeGreaterThan(0);
    await reviewClip(f.scope, id, { action: "reject" });
    expect((await board(storyboardId)).shotApprovals).toEqual([]); expect((await row(renderId)).status).toBe("READY");
    await expect(readMotion(f.scope, renderId, true, store)).rejects.toThrow();
    await reviewClip(f.scope, id, { action: "approve", watched: true });
    await expect(readMotion(f.scope, renderId, true, store)).rejects.toThrow();
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
    expect(JSON.stringify(await listClips(f.scope))).not.toContain(clip.sourceKey);
  });
  it("requires rights, worker readiness and current editor authority before accepting originals", async () => {
    const f = await setup();
    await expect(uploadClip(f.scope, { label: "No rights", rightsConfirmed: false }, source, store)).rejects.toThrow();
    await db.workerHeartbeat.update({ where: { id: workerId }, data: { motionReady: false } });
    await expect(upload(f)).rejects.toThrow("worker");
    expect(await db.videoClip.count({ where: { businessId: f.scope.businessId } })).toBe(0);
    await db.membership.update({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } }, data: { role: "VIEWER" } });
    await expect(upload(f)).rejects.toThrow();
  });
  it("isolates clip preview/review and storyboard selection across businesses", async () => {
    const a = await setup(), b = await setup(), clip = await readyClip(a); await reviewClip(a.scope, clip.id, { action: "approve", watched: true });
    await expect(readClip(b.scope, clip.id, store)).rejects.toThrow("not found");
    await expect(reviewClip(b.scope, clip.id, { action: "remove" })).rejects.toThrow("not found");
    await expect(useClip(b, clip)).rejects.toThrow("unavailable"); expect(await listClips(b.scope)).toHaveLength(0);
  });
  it("enforces independent clip review and invalidates previous approvals on policy change", async () => {
    const f = await setup(), clip = await readyClip(f); await reviewClip(f.scope, clip.id, { action: "approve", watched: true });
    const second = await setup(); await db.membership.create({ data: { organizationId: f.scope.organizationId, userId: second.scope.actorId, role: "ADMIN" } });
    await manageApprovals(f.scope, { action: "policy", independent: true });
    expect((await db.videoClip.findUniqueOrThrow({ where: { id: clip.id } })).status).toBe("READY");
    await expect(reviewClip(f.scope, clip.id, { action: "approve", watched: true })).rejects.toThrow();
  });
  it.each(["brand", "role", "source"])("blocks stale %s before clip decoding", async reason => {
    const f = await setup(), id = await upload(f), clip = await db.videoClip.findUniqueOrThrow({ where: { id } });
    if (reason === "brand") await db.business.update({ where: { id: f.scope.businessId }, data: { version: { increment: 1 } } });
    if (reason === "role") await db.membership.update({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } }, data: { role: "VIEWER" } });
    if (reason === "source") objects.set(clip.sourceKey, Buffer.from("tampered"));
    const process = vi.fn(async () => processed); await runOneClip(process, () => store);
    expect(process).not.toHaveBeenCalled(); expect((await db.videoClip.findUniqueOrThrow({ where: { id } })).status).toBe("FAILED");
  });
  it("rejects context changes during decoding before normalized storage", async () => {
    const f = await setup(), id = await upload(f), put = vi.fn(store.put);
    await runOneClip(async () => { await db.business.update({ where: { id: f.scope.businessId }, data: { confirmedAt: null } }); return processed; }, () => ({ ...store, put }));
    expect(put).not.toHaveBeenCalled(); expect((await db.videoClip.findUniqueOrThrow({ where: { id } })).status).toBe("FAILED");
  });
  it("holds ambiguous stored clips privately and recovers by read-back without reprocessing", async () => {
    const f = await setup(), id = await upload(f), process = vi.fn(async () => processed);
    await runOneClip(process, () => ({ ...store, put: async (...args) => { await store.put(...args); throw Error("lost acknowledgement"); } }));
    await expect(readClip(f.scope, id, store)).rejects.toThrow("processed");
    await recoverClipStorage(f.scope, id, store); expect(process).toHaveBeenCalledOnce();
    expect((await db.videoClip.findUniqueOrThrow({ where: { id } })).status).toBe("READY");
    await expect(recoverClipStorage(f.scope, id, store)).rejects.toThrow("No processed");
  });
  it("does not retry unknown uploads and retains quota until both objects are deleted", async () => {
    const f = await setup();
    await expect(uploadClip(f.scope, { label: "Ambiguous", rightsConfirmed: true }, source, { ...store, put: async (...args) => { await store.put(...args); throw Error("uncertain"); } })).rejects.toThrow("private");
    const clip = await db.videoClip.findFirstOrThrow({ where: { businessId: f.scope.businessId } });
    await expect(recoverClipStorage(f.scope, clip.id, store)).rejects.toThrow("No processed");
    expect(await runOneClip(async () => processed, () => store)).toBe(false);
    await reviewClip(f.scope, clip.id, { action: "remove" });
    const expiry = (await db.videoClip.findUniqueOrThrow({ where: { id: clip.id } })).purgeAfter;
    await reviewClip(f.scope, clip.id, { action: "remove" }); expect((await db.videoClip.findUniqueOrThrow({ where: { id: clip.id } })).purgeAfter).toEqual(expiry);
    await db.videoClip.update({ where: { id: clip.id }, data: { purgeAfter: new Date(0) } });
    const now = new Date();
    await purgeClips({ ...store, remove: async key => { if (key === clip.objectKey) throw Error("temporary"); await store.remove(key); } }, now);
    expect((await db.videoClip.findUniqueOrThrow({ where: { id: clip.id } })).status).toBe("DELETING");
    await db.videoClip.update({ where: { id: clip.id }, data: { leaseUntil: new Date(0) } });
    await purgeClips(store, now); expect((await db.videoClip.findUniqueOrThrow({ where: { id: clip.id } })).status).toBe("DELETED");
    expect(objects.has(clip.sourceKey)).toBe(false);
  });
  it("rejects clips shorter than the shot and detects stored-byte tampering", async () => {
    const f = await setup(), clip = await readyClip(f); await reviewClip(f.scope, clip.id, { action: "approve", watched: true });
    await db.videoClip.update({ where: { id: clip.id }, data: { durationMs: 1000 } }); await expect(useClip(f, clip)).rejects.toThrow("shorter");
    await db.videoClip.update({ where: { id: clip.id }, data: { durationMs: 6000 } });
    const storyboardId = await useClip(f, clip), id = await queue(f, storyboardId); objects.set(clip.objectKey, Buffer.from("changed"));
    await expect(readClip(f.scope, clip.id, store)).rejects.toThrow("integrity");
    await runOneMotion(f.renderer, () => store); expect(f.renderer).not.toHaveBeenCalled(); expect((await row(id)).status).toBe("FAILED");
  });
  it("prevents concurrent clip/render CPU leases and never retries expired decoder work", async () => {
    const f = await setup(), id = await upload(f);
    await db.videoClip.update({ where: { id }, data: { status: "RUNNING", leaseUntil: new Date(Date.now() + 100000) } });
    const renderId = await queue(f); await runOneMotion(f.renderer, () => store); expect(f.renderer).not.toHaveBeenCalled();
    expect(await runOneClip(async () => processed, () => store)).toBe(false);
    await db.videoClip.update({ where: { id }, data: { leaseUntil: new Date(0) } }); await recoverClipLeases();
    expect((await db.videoClip.findUniqueOrThrow({ where: { id } })).status).toBe("FAILED");
    await runOneMotion(f.renderer, () => store); expect((await row(renderId)).status).toBe("READY");
  });
  it("bounds retained clip storage and shares the non-replenishing daily CPU allowance", async () => {
    const f = await setup(); for (let i = 0; i < 5; i++) { const id = await upload(f); await reviewClip(f.scope, id, { action: "remove" }); }
    await expect(upload(f)).rejects.toThrow("Five private");
    const other = await setup(); vi.stubEnv("MOTION_RENDER_DAILY_LIMIT", "1");
    await db.workerHeartbeat.update({ where: { id: workerId }, data: { configurationHash: workerConfigurationHash() } });
    await expect(upload(other)).rejects.toThrow("daily video processing");
  });
  it("validates selected source bounds before saving and resets only the changed shot review", async () => {
    const f = await setup(), clip = await readyClip(f); await reviewClip(f.scope, clip.id, { action: "approve", watched: true });
    const id = await useClip(f, clip); await approve(f, id);
    const document = storyboardDocument.parse((await board(id)).document);
    document.shots[0].clipEdit = { ...DEFAULT_CLIP_EDIT, startMs: 1250 };
    await expect(manageVideo(f.scope, { action: "save", storyboardId: id, document }, () => store)).rejects.toThrow("selected range");
    expect((await board(id)).status).toBe("APPROVED");
    document.shots[0].clipEdit = { startMs: 1000, fit: "cover", x: 75, y: 25 };
    const next = (await manageVideo(f.scope, { action: "save", storyboardId: id, document }, () => store)).storyboardId!;
    expect((await board(next)).shotApprovals).toHaveLength(2);
    await expect(manageVideo(f.scope, { action: "approve-storyboard", storyboardId: next }, () => store)).rejects.toThrow("every current shot");
    const renderId = await queue(f, next); await runOneMotion(f.renderer, () => store);
    expect(f.renderer.mock.calls[0][0].shots[0].clipEdit).toEqual({ startMs: 1000, fit: "cover", x: 75, y: 25 });
    await manageVideo(f.scope, { action: "approve-render", renderId, continuityReviewed: true }, () => store);
    const changed = storyboardDocument.parse((await board(next)).document); changed.shots[0].clipEdit!.x = 25;
    const third = (await manageVideo(f.scope, { action: "save", storyboardId: next, document: changed }, () => store)).storyboardId!;
    expect((await board(third)).shotApprovals).toHaveLength(2);
    await expect(readMotion(f.scope, renderId, true, store)).rejects.toThrow("changed");
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
  });
  it.each(["before-encoding", "during-encoding", "before-download"])("rechecks the selected range %s", async phase => {
    const f = await setup(), clip = await readyClip(f); await reviewClip(f.scope, clip.id, { action: "approve", watched: true });
    const document = storyboardDocument.parse((await board(f.id)).document); document.shots[0].clip = { id: clip.id, sha256: clip.sha256 }; document.shots[0].clipEdit = { ...DEFAULT_CLIP_EDIT, startMs: 1000 };
    const storyboardId = (await manageVideo(f.scope, { action: "save", storyboardId: f.id, document }, () => store)).storyboardId!, id = await queue(f, storyboardId);
    const shorten = () => db.videoClip.update({ where: { id: clip.id }, data: { durationMs: 5500 } });
    if (phase === "before-encoding") await shorten();
    if (phase === "during-encoding") f.renderer.mockImplementationOnce(async document => {
      await shorten(); return { bytes: Buffer.from("controlled stale output"), durationMs: totalDuration(document), width: 720, height: 1280 };
    });
    await runOneMotion(f.renderer, () => store);
    if (phase === "before-download") {
      await manageVideo(f.scope, { action: "approve-render", renderId: id, continuityReviewed: true }, () => store);
      await shorten();
      await expect(readMotion(f.scope, id, true, store)).rejects.toThrow("selected range");
    } else {
      expect(f.renderer).toHaveBeenCalledTimes(phase === "before-encoding" ? 0 : 1);
      expect((await row(id)).status).toBe("FAILED");
      expect(objects.has((await row(id)).objectKey)).toBe(false);
    }
  });
  it("retains reviewed legacy clip bytes but refuses unknown processors and silent legacy queue upgrades", async () => {
    const f = await setup(), clip = await readyClip(f); await reviewClip(f.scope, clip.id, { action: "approve", watched: true });
    await db.videoClip.update({ where: { id: clip.id }, data: { processorVersion: "silent-clip-v1" } });
    expect((await listClips(f.scope)).find(c => c.id === clip.id)?.usable).toBe(true);
    expect(await readClip(f.scope, clip.id, store)).toEqual(processed.bytes);
    await useClip(f, clip);
    await db.videoClip.update({ where: { id: clip.id }, data: { processorVersion: "unverified-future-processor" } });
    expect((await listClips(f.scope)).find(c => c.id === clip.id)?.usable).toBe(false);
    await expect(readClip(f.scope, clip.id, store)).rejects.toThrow("changed");
    const queued = await upload(f); await db.videoClip.update({ where: { id: queued }, data: { processorVersion: "silent-clip-v1" } });
    const process = vi.fn(async () => processed); await runOneClip(process, () => store);
    expect(process).not.toHaveBeenCalled(); expect((await db.videoClip.findUniqueOrThrow({ where: { id: queued } })).status).toBe("FAILED");
  });
  it.each(["expired", "unconfirmed", "brand-version"])("does not offer historically approved %s clips for scene selection", async reason => {
    const f = await setup(), clip = await readyClip(f); await reviewClip(f.scope, clip.id, { action: "approve", watched: true });
    if (reason === "expired") await db.videoClip.update({ where: { id: clip.id }, data: { purgeAfter: new Date(0) } });
    if (reason === "unconfirmed") await db.business.update({ where: { id: f.scope.businessId }, data: { confirmedAt: null } });
    if (reason === "brand-version") await db.business.update({ where: { id: f.scope.businessId }, data: { version: { increment: 1 } } });
    expect((await listClips(f.scope)).find(c => c.id === clip.id)).toMatchObject({ status: "APPROVED", usable: false });
  });
  it("blocks legacy renderer approval and download while retaining bytes and allowing a reviewed replacement", async () => {
    const f = await setup(), id = await queue(f); await runOneMotion(f.renderer, () => store);
    await manageVideo(f.scope, { action: "approve-render", renderId: id, continuityReviewed: true }, () => store);
    const old = await db.motionRender.update({ where: { id }, data: { rendererVersion: "motion-legacy" } });
    const originalBytes = Buffer.from(objects.get(old.objectKey)!);
    await expect(manageVideo(f.scope, { action: "approve-render", renderId: id, continuityReviewed: true }, () => store)).rejects.toThrow("current verified render");
    await expect(readMotion(f.scope, id, true, store)).rejects.toThrow("current storyboard");
    const next = await manageVideo(f.scope, { action: "render", storyboardId: f.id }, () => store);
    expect(next.renderId).not.toBe(id); await runOneMotion(f.renderer, () => store);
    await expect(readMotion(f.scope, next.renderId!, true, store)).rejects.toThrow("awaiting approval");
    expect(objects.get(old.objectKey)).toEqual(originalBytes);
    expect((await listVideo(f.scope)).renders.find(r => r.id === id)?.rendererVersion).toBe("motion-legacy");
  });
  it("reuses approved same-business artwork without generating or charging again", async () => {
    const f = await setup(), image = await artwork(f), storyboardId = await useArtwork(f, image.asset);
    expect((await listVideo(f.scope)).assets).toContainEqual(expect.objectContaining({ id: image.asset.id, generated: true }));
    const id = await queue(f, storyboardId); await runOneMotion(f.renderer, () => store);
    expect(f.renderer.mock.calls[0][1]?.get(image.asset.id)).toEqual(image.bytes);
    expect((await row(id)).status).toBe("READY");
    await manageVideo(f.scope, { action: "approve-render", renderId: id, continuityReviewed: true }, () => store);
    expect((await readMotion(f.scope, id, true, store)).bytes.length).toBeGreaterThan(0);
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
    await db.imageGeneration.update({ where: { id: image.generation.id }, data: { status: "REJECTED", approvedBy: null } });
    await expect(readMotion(f.scope, id, true, store)).rejects.toThrow("source approval changed");
    const repaired = storyboardDocument.parse((await board(storyboardId)).document); repaired.shots[0].asset = null;
    expect((await manageVideo(f.scope, { action: "save", storyboardId, document: repaired }, () => store)).storyboardId).toBeTruthy();
  });
  it("never uses generated artwork as a logo and rejects another tenant's artwork", async () => {
    const f = await setup(), other = await setup(), image = await artwork(f);
    const document = storyboardDocument.parse((await board(f.id)).document); document.logo = { id: image.asset.id, sha256: image.asset.sha256 };
    await expect(manageVideo(f.scope, { action: "save", storyboardId: f.id, document }, () => store)).rejects.toThrow("original logo");
    await expect(useArtwork(other, image.asset)).rejects.toThrow("source approval changed");
    expect((await listVideo(other.scope)).assets.some(a => a.id === image.asset.id)).toBe(false);
  });
  it.each(["rejected", "copy-edited", "copy-blocked", "newer-authorized", "reference-revoked", "reference-tampered", "archived"])("blocks stale artwork when %s before encoding", async reason => {
    const f = await setup(), image = await artwork(f);
    const reference = await uploadAsset(f.scope, { label: "Style reference", purpose: "reference", rightsConfirmed: true }, image.bytes, store);
    await changeAsset(f.scope, reference.asset.id, { action: "approve", approved: true });
    const original = await db.brandAsset.findUniqueOrThrow({ where: { id: reference.asset.id } });
    await db.imageGeneration.update({ where: { id: image.generation.id }, data: { references: [{ id: original.id, sha256: original.sha256, parent: false }] } });
    const storyboardId = await useArtwork(f, image.asset), id = await queue(f, storyboardId);
    if (reason === "rejected") await db.imageGeneration.update({ where: { id: image.generation.id }, data: { status: "REJECTED" } });
    if (reason === "copy-edited") await db.creativeRevision.create({ data: { organizationId: f.scope.organizationId, itemId: image.item.id, version: 2, status: "READY", authorId: f.scope.actorId, content: {} } });
    if (reason === "copy-blocked") await db.reviewComment.create({ data: { businessId: f.scope.businessId, organizationId: f.scope.organizationId, revisionId: image.generation.revisionId, actorId: f.scope.actorId, body: "Check source claims", blocking: true } });
    if (reason === "newer-authorized") await db.imageGeneration.create({ data: { ...image.generation, knowledgeContext: {}, references: [], route: {}, usage: undefined, id: crypto.randomUUID(), version: 2, status: "QUEUED", approvedBy: null } });
    if (reason === "reference-revoked") await changeAsset(f.scope, original.id, { action: "approve", approved: false });
    if (reason === "reference-tampered") await db.brandAsset.update({ where: { id: original.id }, data: { sha256: "0".repeat(64) } });
    if (reason === "archived") await db.brandAsset.update({ where: { id: image.asset.id }, data: { status: "ARCHIVED" } });
    expect((await listVideo(f.scope)).assets.some(a => a.id === image.asset.id)).toBe(false);
    await runOneMotion(f.renderer, () => store); expect(f.renderer).not.toHaveBeenCalled(); expect((await row(id)).status).toBe("FAILED");
  });
  it("rechecks source approval after encoding and before any output is stored", async () => {
    const f = await setup(), image = await artwork(f), id = await queue(f, await useArtwork(f, image.asset)), put = vi.fn(store.put);
    await runOneMotion(async document => { await db.imageGeneration.update({ where: { id: image.generation.id }, data: { status: "REJECTED" } }); return f.renderer(document); }, () => ({ ...store, put }));
    expect(put).not.toHaveBeenCalled(); expect((await row(id)).status).toBe("FAILED");
  });
  it("requires each shot review, queues once, renders once and gates downloads on final approval", async () => {
    const f = await setup(); await expect(manageVideo(f.scope, { action: "approve-storyboard", storyboardId: f.id }, () => store)).rejects.toThrow("every current shot");
    const id = await queue(f); const again = await manageVideo(f.scope, { action: "render", storyboardId: f.id }, () => store); expect(again.renderId).toBe(id);
    await runOneMotion(f.renderer, () => store); await runOneMotion(f.renderer, () => store); expect(f.renderer).toHaveBeenCalledTimes(1); expect((await row(id)).status).toBe("READY");
    expect((await readMotion(f.scope, id, false, store)).bytes.length).toBeGreaterThan(0);
    await expect(readMotion(f.scope, id, true, store)).rejects.toThrow("awaiting approval");
    await expect(manageVideo(f.scope, { action: "approve-render", renderId: id }, () => store)).rejects.toThrow("Watch");
    await manageVideo(f.scope, { action: "approve-render", renderId: id, continuityReviewed: true }, () => store);
    expect((await readMotion(f.scope, id, true, store)).document.shots).toHaveLength(3);
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
  });
  it("changing one shot preserves unaffected reviews and invalidates the assembled output", async () => {
    const f = await setup(), id = await queue(f); await runOneMotion(f.renderer, () => store);
    const document = storyboardDocument.parse((await board(f.id)).document); document.shots[1].caption = "Explore considered spaces";
    const result = await manageVideo(f.scope, { action: "save", storyboardId: f.id, document }, () => store);
    const next = await board(result.storyboardId!); expect(next.shotApprovals).toHaveLength(2); expect(next.status).toBe("DRAFT");
    await expect(readMotion(f.scope, id, false, store)).rejects.toThrow("changed");
    await expect(manageVideo(f.scope, { action: "save", storyboardId: f.id, document }, () => store)).rejects.toThrow("changed");
  });
  it("blocks fabricated dates and excessive duration before saving any new version", async () => {
    const f = await setup(), document = storyboardDocument.parse((await board(f.id)).document); document.shots[0].caption = "Join us this Saturday";
    await expect(manageVideo(f.scope, { action: "save", storyboardId: f.id, document }, () => store)).rejects.toThrow("Confirm or remove"); expect((await board(f.id)).status).toBe("DRAFT");
    document.shots[0].durationMs = 31000; await expect(manageVideo(f.scope, { action: "save", storyboardId: f.id, document }, () => store)).rejects.toThrow();
  });
  it("isolates storyboard, render and review access across tenants", async () => {
    const a = await setup(), b = await setup(), id = await queue(a); await runOneMotion(a.renderer, () => store);
    await expect(manageVideo(b.scope, { action: "approve-storyboard", storyboardId: a.id }, () => store)).rejects.toThrow("not found");
    await expect(readMotion(b.scope, id, false, store)).rejects.toThrow("unavailable"); expect((await listVideo(b.scope)).renders).toHaveLength(0);
  });
  it("revoked originals block rendering, and the user can repair the draft", async () => {
    const f = await setup(), bytes = await sharp({ create: { width: 40, height: 40, channels: 4, background: "#123456" } }).png().toBuffer();
    const asset = await uploadAsset(f.scope, { label: "Product", purpose: "product", rightsConfirmed: true }, bytes, store);
    await changeAsset(f.scope, asset.asset.id, { action: "approve", approved: true });
    const saved = await db.brandAsset.findUniqueOrThrow({ where: { id: asset.asset.id } }), document = storyboardDocument.parse((await board(f.id)).document);
    document.shots[0].asset = { id: saved.id, sha256: saved.sha256 };
    const next = await manageVideo(f.scope, { action: "save", storyboardId: f.id, document }, () => store), id = await queue(f, next.storyboardId!);
    await changeAsset(f.scope, saved.id, { action: "approve", approved: false });
    await runOneMotion(f.renderer, () => store); expect(f.renderer).not.toHaveBeenCalled(); expect((await row(id)).status).toBe("FAILED");
    document.shots[0].asset = null; expect((await manageVideo(f.scope, { action: "save", storyboardId: next.storyboardId!, document }, () => store)).storyboardId).toBeTruthy();
  });
  it("a profile change during rendering prevents storage and delivery", async () => {
    const f = await setup(), id = await queue(f), put = vi.fn(store.put);
    await runOneMotion(async document => { await db.business.update({ where: { id: f.scope.businessId }, data: { version: { increment: 1 } } }); return f.renderer(document); }, () => ({ ...store, put }));
    expect(put).not.toHaveBeenCalled(); expect((await row(id)).status).toBe("FAILED");
  });
  it("recovers ambiguous storage only by reading its fingerprint, without rerendering", async () => {
    const f = await setup(), id = await queue(f);
    await runOneMotion(f.renderer, () => ({ ...store, put: async (key, bytes) => { objects.set(key, bytes); throw Error("lost acknowledgement"); } }));
    expect((await row(id)).status).toBe("FAILED"); await recoverMotionStorage(f.scope, id, store); expect((await row(id)).status).toBe("READY");
    await runOneMotion(f.renderer, () => store); expect(f.renderer).toHaveBeenCalledTimes(1);
    objects.set((await row(id)).objectKey, Buffer.from("tampered")); await expect(readMotion(f.scope, id, false, store)).rejects.toThrow("integrity");
  });
  it("cancels before rendering without invoking the renderer", async () => {
    const f = await setup(), id = await queue(f);
    await manageVideo(f.scope, { action: "cancel-render", renderId: id }, () => store); await runOneMotion(f.renderer, () => store);
    expect(f.renderer).not.toHaveBeenCalled(); expect(await row(id)).toMatchObject({ status: "CANCELLED", bytes: 0 });
  });
  it("does not rerender expired worker leases automatically", async () => {
    const f = await setup(), id = await queue(f);
    await db.motionRender.update({ where: { id }, data: { status: "RUNNING", leaseUntil: new Date(0) } }); await recoverMotionLeases();
    await runOneMotion(f.renderer, () => store); expect(f.renderer).not.toHaveBeenCalled(); expect((await row(id)).status).toBe("FAILED");
  });
  it("keeps the global render slot occupied until an active render settles", async () => {
    const f = await setup(), id = await queue(f);
    await runOneMotion(async document => {
      await expect(manageVideo(f.scope, { action: "cancel-render", renderId: id }, () => store)).rejects.toThrow("Only queued");
      expect(await runOneMotion(f.renderer, () => store)).toBe(false);
      expect((await row(id)).status).toBe("RUNNING");
      return f.renderer(document);
    }, () => store);
    expect(f.renderer).toHaveBeenCalledTimes(1); expect((await row(id)).status).toBe("READY");
  });
  it("revokes final approval when any saved shot review is withdrawn", async () => {
    const f = await setup(), id = await queue(f); await runOneMotion(f.renderer, () => store);
    await manageVideo(f.scope, { action: "approve-render", renderId: id, continuityReviewed: true }, () => store);
    const document = storyboardDocument.parse((await board(f.id)).document);
    await manageVideo(f.scope, { action: "review-shot", storyboardId: f.id, shotId: document.shots[0].id, approved: false }, () => store);
    expect((await row(id)).status).toBe("READY");
    await expect(readMotion(f.scope, id, true, store)).rejects.toThrow("awaiting approval");
    await expect(readMotion(f.scope, id, false, store)).rejects.toThrow("current storyboard");
  });
  it("does not queue work without a fresh matching renderer heartbeat", async () => {
    const f = await setup(); await approve(f);
    await db.workerHeartbeat.update({ where: { id: workerId }, data: { lastSeenAt: new Date(0) } });
    await expect(manageVideo(f.scope, { action: "render", storyboardId: f.id }, () => store)).rejects.toThrow("not ready");
    expect(await db.motionRender.count({ where: { storyboardId: f.id } })).toBe(0);
  });
  it("removal revokes download immediately and cleanup retains quota after a failed delete", async () => {
    const f = await setup(), id = await queue(f); await runOneMotion(f.renderer, () => store);
    await manageVideo(f.scope, { action: "archive-render", renderId: id }, () => store); await expect(readMotion(f.scope, id, false, store)).rejects.toThrow("unavailable");
    const deadline = (await row(id)).purgeAfter;
    await manageVideo(f.scope, { action: "archive-render", renderId: id }, () => store);
    expect((await row(id)).purgeAfter).toEqual(deadline);
    await db.motionRender.update({ where: { id }, data: { purgeAfter: new Date(0) } });
    await purgeMotion({ ...store, remove: async () => { throw Error("timeout"); } }); expect((await row(id)).bytes).toBeGreaterThan(0);
    await db.motionRender.update({ where: { id }, data: { leaseUntil: new Date(0) } }); await purgeMotion(store); expect(await row(id)).toMatchObject({ status: "DELETED", bytes: 0 });
  });
  it("requires current editing rights and an independent reviewer when configured", async () => {
    const f = await setup(); await db.business.update({ where: { id: f.scope.businessId }, data: { independentApproval: true } }); await expect(approve(f)).rejects.toThrow("different person");
    await db.membership.update({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } }, data: { role: "VIEWER" } });
    await expect(manageVideo(f.scope, { action: "create", itemId: f.item.id }, () => store)).rejects.toThrow("editing access");
  });
  it("enforces a global CPU admission ceiling independently of paid AI", async () => {
    const admitted = await setup(); await queue(admitted);
    const f = await setup(); await approve(f); vi.stubEnv("MOTION_RENDER_DAILY_LIMIT", "1");
    await db.workerHeartbeat.update({ where: { id: workerId }, data: { configurationHash: workerConfigurationHash() } });
    await expect(manageVideo(f.scope, { action: "render", storyboardId: f.id }, () => store)).rejects.toThrow("daily motion-render limit");
    expect(await db.motionRender.count({ where: { storyboardId: f.id } })).toBe(0);
  });
});
