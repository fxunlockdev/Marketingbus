import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { uploadClip, runOneClip, reviewClip, readClip, recoverClipStorage, recoverClipLeases, purgeClips, listClips } from "../src/lib/video/clips";
import { manageVideo, listVideo, readMotion } from "../src/lib/video/service";
import { runOneMotion } from "../src/lib/video/worker";
import { renderMotion } from "../src/lib/video/render";
import { normalizeAudio } from "../src/lib/video/audio-normalizer";
import { storyboardDocument, totalDuration, type StoryboardDocument } from "../src/lib/video/document";
import { WORKER_RUNTIME, workerConfigurationHash } from "../src/lib/production/readiness";
import type { AssetStore } from "../src/lib/assets/storage";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local test DB required");
// Three seconds of real, synthetic PCM, never a licensed/customer asset.
function wav() {
  const bytes = Buffer.alloc(44 + 3 * 48000 * 2); bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let n = 0; n < 3 * 48000; n++) bytes.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * 440 * n / 48000)), 44 + n * 2); return bytes;
}
suite("private instrumental audio lifecycle", () => {
  const orgs: string[] = [], users: string[] = [], workerId = `audio-fixture-${crypto.randomUUID()}`, objects = new Map<string, Buffer>(), source = wav();
  const store: AssetStore = { put: async (key, bytes, _mime, immutable) => { if (immutable && objects.has(key)) throw Error("immutable"); objects.set(key, Buffer.from(bytes)); }, get: async key => { const bytes = objects.get(key); if (!bytes) throw Error("missing"); return bytes; }, remove: async key => { objects.delete(key); } };
  const pulse = () => db.workerHeartbeat.upsert({ where: { id: workerId }, create: { id: workerId, runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), executionEnabled: false, motionReady: true }, update: { runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), motionReady: true, lastSeenAt: new Date() } });
  beforeEach(async () => { vi.stubEnv("MOTION_RENDERING_ENABLED", "true"); vi.stubEnv("AUDIO_PROCESSING_ENABLED", "true"); vi.stubEnv("MOTION_RENDER_DAILY_LIMIT", "100"); vi.stubEnv("PAID_EXECUTION_ENABLED", "false"); await pulse(); });
  afterAll(async () => {
    const where = { organizationId: { in: orgs } }, clips = await db.videoClip.findMany({ where }), renders = await db.motionRender.findMany({ where });
    await db.motionAuthorization.deleteMany({ where: { key: { in: [...clips, ...renders].map(r => r.id) } } }); await db.videoClip.deleteMany({ where }); await db.motionRender.deleteMany({ where }); await db.videoStoryboard.deleteMany({ where });
    await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.user.deleteMany({ where: { id: { in: users } } }); await db.workerHeartbeat.deleteMany({ where: { id: workerId } }); vi.unstubAllEnvs(); await db.$disconnect();
  });
  async function setup() {
    const user = await db.user.create({ data: { email: `audio-${crypto.randomUUID()}@example.test`, name: "Audio fixture", passwordHash: "no-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "AUDIO FIXTURE", wallet: { create: {} }, memberships: { create: { userId: user.id, role: "OWNER" } } } }); orgs.push(org.id);
    const b = await db.business.create({ data: { organizationId: org.id, name: "Design studio", offering: "Architecture consultations", confirmedAt: new Date() } });
    return { organizationId: org.id, businessId: b.id, actorId: user.id };
  }
  type Scope = Awaited<ReturnType<typeof setup>>;
  const upload = (scope: Scope, storage = store) => uploadClip(scope, { label: "Instrumental fixture", rightsConfirmed: true, instrumentalConfirmed: true }, source, storage, "AUDIO");
  const row = (id: string) => db.videoClip.findUniqueOrThrow({ where: { id } });
  const processor = vi.fn(async () => ({ bytes: source, durationMs: 3000 }));
  async function ready(scope: Scope) { const { clipId } = await upload(scope); await runOneClip(processor, () => store); return clipId; }
  async function approved(scope: Scope) { const id = await ready(scope); await reviewClip(scope, id, { action: "approve", watched: true }, "AUDIO"); return id; }
  async function board(scope: Scope, trackId: string) {
    const plan = await db.productionPlan.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId, brandVersion: 1, title: "Music plan", creditCeiling: 0, items: { create: { title: "Considered spaces", format: "motion", channel: "YouTube", brief: {} } } }, include: { items: true } });
    const created = await manageVideo(scope, { action: "create", itemId: plan.items[0].id }, () => store), track = await row(trackId);
    const document = storyboardDocument.parse({ title: "Considered spaces", background: "#112233", logo: null, soundtrack: { id: trackId, sha256: track.sha256, startMs: 500, gainPercent: 25, fadeInMs: 250, fadeOutMs: 250 }, shots: [{ id: "a", label: "Opening", caption: "Design studio", durationMs: 2000, motion: "hold", asset: null }] });
    return { id: (await manageVideo(scope, { action: "save", storyboardId: created.storyboardId, document }, () => store)).storyboardId!, document };
  }
  async function queue(scope: Scope, id: string) {
    await manageVideo(scope, { action: "review-shot", storyboardId: id, shotId: "a", approved: true }, () => store); await manageVideo(scope, { action: "approve-storyboard", storyboardId: id }, () => store);
    return (await manageVideo(scope, { action: "render", storyboardId: id }, () => store)).renderId!;
  }
  const renderer = async (d: StoryboardDocument) => ({ bytes: Buffer.from("controlled media fixture, not playable"), durationMs: totalDuration(d), width: 720, height: 1280 });
  it("quarantines originals, separates music from footage, requires listening approval and spends no credits", async () => {
    const s = await setup(), { clipId } = await upload(s); await expect(readClip(s, clipId, store, "AUDIO")).rejects.toThrow("processed");
    await runOneClip(processor, () => store); expect((await row(clipId)).status).toBe("READY"); expect((await listClips(s))).toEqual([]); expect((await listVideo(s)).audio).toHaveLength(1);
    await expect(reviewClip(s, clipId, { action: "approve" }, "AUDIO")).rejects.toThrow("Listen"); await reviewClip(s, clipId, { action: "approve", watched: true }, "AUDIO");
    expect((await listClips(s, "AUDIO"))[0].usable).toBe(true); expect(await readClip(s, clipId, store, "AUDIO")).toEqual(source);
    expect(JSON.stringify(await listClips(s, "AUDIO"))).not.toMatch(/sourceKey|objectKey|sourceHash|createdBy/); expect(await db.reservation.count({ where: { organizationId: s.organizationId } })).toBe(0);
  });
  it("rejects cross-tenant, wrong media route, viewer writes and independent self-approval", async () => {
    const s = await setup(), other = await setup(), id = await ready(s);
    await expect(readClip(other, id, store, "AUDIO")).rejects.toThrow(); await expect(readClip(s, id, store)).rejects.toThrow(); await expect(reviewClip(s, id, { action: "remove" })).rejects.toThrow();
    await db.business.update({ where: { id: s.businessId }, data: { independentApproval: true } }); await expect(reviewClip(s, id, { action: "approve", watched: true }, "AUDIO")).rejects.toThrow();
    await db.membership.update({ where: { organizationId_userId: { organizationId: s.organizationId, userId: s.actorId } }, data: { role: "VIEWER" } }); await expect(reviewClip(s, id, { action: "reject" }, "AUDIO")).rejects.toThrow(); await expect(upload(s)).rejects.toThrow();
  });
  it("requires rights, no-vocals confirmation and matching worker configuration", async () => {
    const s = await setup(); await expect(uploadClip(s, { label: "x", rightsConfirmed: true }, source, store, "AUDIO")).rejects.toThrow();
    vi.stubEnv("AUDIO_PROCESSING_ENABLED", "false"); await expect(upload(s)).rejects.toThrow("not enabled"); await pulse(); vi.stubEnv("AUDIO_PROCESSING_ENABLED", "true"); await expect(upload(s)).rejects.toThrow("matching");
    expect(await db.videoClip.count({ where: { businessId: s.businessId } })).toBe(0);
  });
  it("prevents disabled audio decoding and does not automatically retry expired work", async () => {
    const s = await setup(), { clipId } = await upload(s), decode = vi.fn(async () => processor()); vi.stubEnv("AUDIO_PROCESSING_ENABLED", "false"); expect(await runOneClip(decode, () => store)).toBe(false); expect(decode).not.toHaveBeenCalled();
    await db.videoClip.update({ where: { id: clipId }, data: { status: "RUNNING", leaseUntil: new Date(0) } }); await recoverClipLeases(); expect((await row(clipId)).status).toBe("FAILED");
  });
  it("keeps ambiguous writes private and recovers only hash-verified processed output", async () => {
    const s = await setup(), { clipId } = await upload(s); await runOneClip(processor, () => ({ ...store, put: async (...args) => { await store.put(...args); throw Error("lost acknowledgement"); } }));
    expect((await row(clipId)).status).toBe("FAILED"); await expect(readClip(s, clipId, store, "AUDIO")).rejects.toThrow(); await recoverClipStorage(s, clipId, store, "AUDIO"); expect((await row(clipId)).status).toBe("READY");
  });
  it.each(["brand", "source", "role"])("rejects changed %s during processing before output is stored", async reason => {
    const s = await setup(), { clipId } = await upload(s), put = vi.fn(store.put);
    if (reason === "source") objects.set((await row(clipId)).sourceKey, Buffer.from("tampered"));
    await runOneClip(async () => { if (reason === "brand") await db.business.update({ where: { id: s.businessId }, data: { version: 2 } }); if (reason === "role") await db.membership.update({ where: { organizationId_userId: { organizationId: s.organizationId, userId: s.actorId } }, data: { role: "VIEWER" } }); return processor(); }, () => ({ ...store, put }));
    expect(put).not.toHaveBeenCalled(); expect((await row(clipId)).status).toBe("FAILED");
  });
  it.each(["reject", "remove"])("%s revokes dependent storyboard, final approval and downloads", async action => {
    const s = await setup(), track = await approved(s), b = await board(s, track), renderId = await queue(s, b.id); await runOneMotion(renderer, () => store);
    await manageVideo(s, { action: "approve-render", renderId, continuityReviewed: true }, () => store); await readMotion(s, renderId, true, store);
    await reviewClip(s, track, { action }, "AUDIO"); expect((await db.videoStoryboard.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("DRAFT"); expect((await db.motionRender.findUniqueOrThrow({ where: { id: renderId } })).status).toBe("READY"); await expect(readMotion(s, renderId, true, store)).rejects.toThrow();
    const next = await manageVideo(s, { action: "save", storyboardId: b.id, document: { ...b.document, soundtrack: null } }, () => store); expect(next.storyboardId).toBeTruthy();
  });
  it("binds revisions to fresh reviews, prevents short ranges and rechecks revocation during rendering", async () => {
    const s = await setup(), track = await approved(s), b = await board(s, track), old = await queue(s, b.id);
    await expect(manageVideo(s, { action: "save", storyboardId: b.id, document: { ...b.document, soundtrack: { ...b.document.soundtrack!, startMs: 2000 } } }, () => store)).rejects.toThrow("shorter");
    const next = (await manageVideo(s, { action: "save", storyboardId: b.id, document: { ...b.document, soundtrack: { ...b.document.soundtrack!, gainPercent: 30 } } }, () => store)).storyboardId!;
    expect((await db.motionRender.findUniqueOrThrow({ where: { id: old } })).status).toBe("CANCELLED"); expect((await db.videoStoryboard.findUniqueOrThrow({ where: { id: next } })).shotApprovals).toEqual([]);
    const renderId = await queue(s, next), put = vi.fn(store.put); await runOneMotion(async d => { await reviewClip(s, track, { action: "reject" }, "AUDIO"); return renderer(d); }, () => ({ ...store, put }));
    expect(put).not.toHaveBeenCalled(); expect((await db.motionRender.findUniqueOrThrow({ where: { id: renderId } })).status).toBe("FAILED");
  });
  it("retains quota for ambiguous deletion then removes original and normalized files", async () => {
    const s = await setup(), id = await approved(s), media = await row(id); await reviewClip(s, id, { action: "remove" }, "AUDIO"); await db.videoClip.update({ where: { id }, data: { purgeAfter: new Date(0) } });
    await purgeClips({ ...store, remove: async () => { throw Error("unavailable"); } }); expect((await row(id)).status).toBe("DELETING");
    await db.videoClip.update({ where: { id }, data: { leaseUntil: new Date(0) } }); await purgeClips(store); expect((await row(id)).status).toBe("DELETED"); expect(objects.has(media.sourceKey)).toBe(false); expect(objects.has(media.objectKey)).toBe(false);
  });
  it.skipIf(!process.env.TEST_FFMPEG_PATH || !process.env.TEST_FFPROBE_PATH)("runs actual WAV upload → normalize → listen approval → soundtrack → encode → final approval → download", async () => {
    vi.stubEnv("FFMPEG_PATH", process.env.TEST_FFMPEG_PATH!); vi.stubEnv("FFPROBE_PATH", process.env.TEST_FFPROBE_PATH!); await pulse();
    const s = await setup(), { clipId } = await upload(s); await runOneClip(normalizeAudio, () => store); expect((await row(clipId)).status).toBe("READY");
    await reviewClip(s, clipId, { action: "approve", watched: true }, "AUDIO"); const b = await board(s, clipId), renderId = await queue(s, b.id); await runOneMotion(renderMotion, () => store);
    expect((await db.motionRender.findUniqueOrThrow({ where: { id: renderId } })).status).toBe("READY"); await expect(readMotion(s, renderId, true, store)).rejects.toThrow();
    await manageVideo(s, { action: "approve-render", renderId, continuityReviewed: true }, () => store); const result = await readMotion(s, renderId, true, store); expect(Buffer.from(result.bytes).toString("ascii", 4, 8)).toBe("ftyp"); expect(result.document.soundtrack?.id).toBe(clipId);
  }, 60000);
});
