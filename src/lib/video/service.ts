import { randomUUID, createHash } from "node:crypto";
import type { Prisma, VideoStoryboard } from "@prisma/client";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { currentItem, lockBusiness, type Scope } from "../production/service";
import { assertBrandEditor } from "../knowledge/analysis";
import { assertReviewer, assertNoBlockingComments } from "../workflows/approvals";
import { approvedFactText, evaluateCreative } from "../production/quality";
import { invalidatePublications } from "../social/service";
import { assetStore, type AssetStore } from "../assets/storage";
import { WORKER_RUNTIME, HEARTBEAT_TTL_MS, workerConfigurationHash } from "../production/readiness";
import { storyboardDocument, shotApprovals, totalDuration, clipRangeFits, soundtrackRangeFits, type StoryboardDocument, type VideoShot } from "./document";
import { MAX_VIDEO_BYTES, MOTION_RENDERER_VERSION, motionDailyLimit, motionHash } from "./limits";
import { eligibleMotionAssets, type MotionAssetClient } from "./assets";
import { eligibleClips, listClips } from "./clips";
import type { ShotContextClient } from "./generation-context";
import { videoLayout } from "./layout";
import { layoutText } from "../typography";
import { requireAudioProcessing } from "./audio-normalizer";
import { creativeSchema } from "../production/content";
import { weeklyVideoContext, type WeeklyVideoAuthorization } from "../workflows/weekly-video-policy";
const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), itemId: z.string().min(1) }).strict(),
  z.object({ action: z.literal("save"), storyboardId: z.string().min(1), document: storyboardDocument }).strict(),
  z.object({ action: z.literal("review-shot"), storyboardId: z.string().min(1), shotId: z.string().min(1), approved: z.boolean() }).strict(),
  z.object({ action: z.enum(["approve-storyboard", "render"]), storyboardId: z.string().min(1) }).strict(),
  z.object({ action: z.enum(["approve-render", "reject-render", "cancel-render", "archive-render"]), renderId: z.string().min(1), continuityReviewed: z.boolean().optional() }).strict(),
]);
export const videoStore = () => assetStore(MAX_VIDEO_BYTES);
export const videoScope = (row: { businessId: string; organizationId: string; createdBy: string }): Scope => ({ businessId: row.businessId, organizationId: row.organizationId, actorId: row.createdBy });
export function shotHash(document: StoryboardDocument, shot: VideoShot) { return motionHash({ background: document.background, logo: document.logo, shot, ...(document.soundtrack ? { soundtrack: document.soundtrack } : {}), ...(document.format && document.format !== "portrait" ? { format: document.format } : {}) }); }
export async function storyboardContext(scope: Scope, id: string, client: Pick<Prisma.TransactionClient, "business" | "productionItem" | "videoStoryboard" | "videoClip"> & MotionAssetClient & ShotContextClient = db, validateAssets = true) {
  const row = await client.videoStoryboard.findFirst({ where: { id, businessId: scope.businessId, organizationId: scope.organizationId } });
  if (!row) throw new AppError(404, "Storyboard not found.");
  const business = await client.business.findFirstOrThrow({ where: { id: scope.businessId, organizationId: scope.organizationId } });
  const item = await client.productionItem.findFirst({ where: { id: row.itemId, organizationId: scope.organizationId, plan: { businessId: scope.businessId, status: "PROPOSED", brandVersion: business.version } }, include: { revisions: { orderBy: { version: "desc" }, take: 1 } } });
  if (!business.confirmedAt || row.brandVersion !== business.version || row.status === "SUPERSEDED" || !item || (item.revisions[0]?.id ?? null) !== row.copyRevisionId || row.copyRevisionId && item.revisions[0]?.status !== "APPROVED") throw new AppError(409, "Brand, copy or storyboard changed. Create or review the current version.");
  if (row.copyRevisionId && await client.reviewComment.count({ where: { revisionId: row.copyRevisionId, blocking: true, resolvedAt: null } })) throw new AppError(409, "Resolve blocking copy comments first.");
  const document = storyboardDocument.parse(row.document);
  const refs = [document.logo, ...document.shots.map(s => s.asset)].filter(r => r !== null);
  const assets = await eligibleMotionAssets(client, scope, business.version, refs.map(r => r.id));
  if (validateAssets && refs.some(r => !assets.some(a => a.id === r.id && a.sha256 === r.sha256))) throw new AppError(409, "A storyboard asset or its source approval changed. Use current approved originals or artwork.");
  if (validateAssets && document.logo && !assets.some(a => a.id === document.logo!.id && a.generationId === null && a.purpose === "logo")) throw new AppError(409, "Use an approved original logo, not generated artwork.");
  const clips = await eligibleClips(client, scope, business.version, document.shots.flatMap(s => s.clip ? [s.clip.id] : []));
  if (validateAssets && document.shots.some(s => s.clip && !clips.some(c => c.id === s.clip!.id && c.sha256 === s.clip!.sha256 && clipRangeFits(s, c.durationMs)))) throw new AppError(409, "A scene clip is unavailable, unapproved or shorter than its selected range. Choose current approved footage or adjust its start and duration.");
  const audio = await eligibleClips(client, scope, business.version, document.soundtrack ? [document.soundtrack.id] : [], "AUDIO");
  if (validateAssets && document.soundtrack && !audio.some(a => a.id === document.soundtrack!.id && a.sha256 === document.soundtrack!.sha256 && soundtrackRangeFits(document, a.durationMs))) throw new AppError(409, "The music is unavailable, unapproved or shorter than the selected reel range. Choose current approved instrumental audio or remove it.");
  for (const shot of document.shots) {
    const quality = evaluateCreative({ headline: shot.caption, caption: shot.caption, cta: "", visualDirection: "", rationale: "", evidenceUsed: [] }, { facts: approvedFactText(business) });
    if (!quality.eligible) throw new AppError(409, quality.defects[0].detail);
    if (validateAssets) {
      try { layoutText(shot.caption, { ...videoLayout(document).text, weight: 600 }); }
      catch { throw new AppError(409, `Caption in “${shot.label}” does not fit the selected format or uses unsupported characters. Shorten or edit it before review.`); }
    }
  }
  return { row, document, assets, clips, audio, business };
}
export async function listVideo(scope: Scope) {
  const member = await db.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
  const business = await db.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId } });
  if (!member || !business) throw new AppError(404, "Business not found.");
  const where = { businessId: scope.businessId, organizationId: scope.organizationId };
  return { canEdit: ["OWNER", "ADMIN", "EDITOR"].includes(member.role),
    clips: await listClips(scope),
    audio: await listClips(scope, "AUDIO"),
    storyboards: await db.videoStoryboard.findMany({ where, orderBy: { createdAt: "desc" }, take: 100 }),
    assets: (await eligibleMotionAssets(db, scope, business.version)).map(a => ({ id: a.id, sha256: a.sha256, label: a.label, purpose: a.purpose, generated: a.generationId !== null })),
    renders: await db.motionRender.findMany({ where, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, storyboardId: true, rendererVersion: true, status: true, durationMs: true, bytes: true, createdAt: true, purgeAfter: true, errorCode: true } }),
  };
}
export async function manageVideo(scope: Scope, raw: unknown, storage: () => AssetStore = videoStore, internal?: WeeklyVideoAuthorization) {
  const input = inputSchema.parse(raw);
  return db.$transaction(async tx => {
    const business = await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
    const weekly = internal ? await weeklyVideoContext(tx, scope, internal) : null;
    if (weekly && (input.action === "create" ? input.itemId !== weekly.task.itemId || weekly.task.storyboardId !== null :
      !["save", "render"].includes(input.action) || !("storyboardId" in input) || input.storyboardId !== weekly.task.storyboardId))
      throw new AppError(409, "The recurring storyboard changed. Automatic approval is not allowed.");
    const audit = (action: string, detail: string) => tx.auditEvent.create({ data: { ...scope, action, detail } });
    if (input.action === "create") {
      const item = await currentItem(tx, scope, input.itemId), copy = item.revisions[0];
      if (!business.confirmedAt || item.plan.brandVersion !== business.version || item.plan.status !== "PROPOSED" || copy && copy.status !== "APPROVED") throw new AppError(409, "Confirm the current brand and approve any existing copy before storyboarding.");
      const previous = await tx.videoStoryboard.findFirst({ where: { itemId: item.id }, orderBy: { version: "desc" } });
      if (previous && weekly) throw new AppError(409, "Manual storyboard work is preserved; continue it in Asset studio.");
      if (previous && previous.brandVersion === business.version && previous.copyRevisionId === (copy?.id || null) && previous.status !== "SUPERSEDED") return { ok: true, storyboardId: previous.id };
      if ((previous?.version || 0) >= 100) throw new AppError(409, "Storyboard version allowance reached.");
      const originals = await tx.brandAsset.findMany({ where: { businessId: scope.businessId, organizationId: scope.organizationId, status: "READY", approvedForGeneration: true, generationId: null }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 100 });
      const logo = originals.find(a => a.purpose === "logo"), hero = originals.find(a => a.purpose === "product") ?? originals.find(a => a.purpose === "reference");
      const ref = (a: typeof logo) => a ? { id: a.id, sha256: a.sha256 } : null;
      const caption = business.offering.length <= 120 ? business.offering : business.name;
      const creative = creativeSchema.safeParse(copy?.content);
      const headline = creative.success && creative.data.headline.length <= 120 ? creative.data.headline : business.name;
      const cta = creative.success && creative.data.cta ? creative.data.cta : "Learn more";
      const document = storyboardDocument.parse({ title: item.title, background: business.color, format: "portrait", logo: ref(logo), shots: [
        { id: randomUUID(), label: "Introduction", caption: headline, durationMs: 5000, motion: "fade", asset: ref(hero) },
        { id: randomUUID(), label: "Offering", caption, durationMs: 5000, motion: "hold", asset: ref(hero) },
        { id: randomUUID(), label: "Invitation", caption: cta, durationMs: Math.max(3000, Math.ceil(cta.length / 6) * 250), motion: "fade", asset: ref(hero) },
      ] });
      if (previous) await tx.videoStoryboard.update({ where: { id: previous.id }, data: { status: "SUPERSEDED" } });
      const row = await tx.videoStoryboard.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId, itemId: item.id, copyRevisionId: copy?.id, brandVersion: business.version, version: (previous?.version || 0) + 1, document, shotApprovals: [], authorId: scope.actorId } });
      if (weekly) await tx.weeklyTask.update({ where: { id: weekly.task.id }, data: { storyboardId: row.id, videoStatus: "STORYBOARD" } });
      await audit("STORYBOARD_CREATED", "Finite motion-card draft from confirmed profile fields and original assets. No model call; each shot needs review.");
      return { ok: true, storyboardId: row.id };
    }
    if ("renderId" in input) {
      const render = await tx.motionRender.findFirst({ where: { id: input.renderId, businessId: scope.businessId, organizationId: scope.organizationId } });
      if (!render) throw new AppError(404, "Render not found.");
      if (input.action === "cancel-render") {
        if (render.status === "CANCELLED") return { ok: true };
        if (render.status !== "QUEUED") throw new AppError(409, "Only queued renders can be cancelled. Wait for active rendering/storage to settle, then remove the output.");
        await tx.motionRender.update({ where: { id: render.id }, data: { status: "CANCELLED", bytes: 0, leaseUntil: null } });
      } else if (input.action === "archive-render") {
        if (render.status === "ARCHIVED") return { ok: true };
        if (["QUEUED", "RUNNING", "STORING", "DELETING"].includes(render.status)) throw new AppError(409, "Wait for the render/storage operation to finish first.");
        if (["DELETED", "CANCELLED"].includes(render.status)) throw new AppError(404, "Render is already unavailable.");
        await tx.motionRender.update({ where: { id: render.id }, data: { status: "ARCHIVED", approvedBy: null, purgeAfter: new Date(Date.now() + 7 * 86400000) } });
      } else {
        const ctx = await storyboardContext(scope, render.storyboardId, tx);
        if (render.rendererVersion !== MOTION_RENDERER_VERSION || ctx.row.status !== "APPROVED" || motionHash(ctx.document) !== render.documentHash || !["READY", "APPROVED", "REJECTED"].includes(render.status) || render.purgeAfter <= new Date()) throw new AppError(409, "Only a current verified render can be reviewed.");
        await assertReviewer(tx, scope, business.independentApproval, ctx.row.authorId);
        if (input.action === "approve-render" && input.continuityReviewed !== true) throw new AppError(400, "Watch the complete video and confirm continuity, caption and brand review.");
        if (render.status === (input.action === "approve-render" ? "APPROVED" : "REJECTED")) return { ok: true };
        await tx.motionRender.update({ where: { id: render.id }, data: { status: input.action === "approve-render" ? "APPROVED" : "REJECTED", approvedBy: input.action === "approve-render" ? scope.actorId : null } });
      }
      await invalidatePublications(tx, scope.businessId);
      await audit("MOTION_REVIEW", `${input.action} recorded. No model call or automatic publication.`); return { ok: true };
    }
    const ctx = await storyboardContext(scope, input.storyboardId, tx, input.action !== "save"), row = ctx.row;
    if (input.action === "save") {
      if (row.version >= 100) throw new AppError(409, "Storyboard version allowance reached.");
      const approvals = shotApprovals.parse(row.shotApprovals).filter(a => input.document.shots.some(s => s.id === a.shotId && a.hash === shotHash(input.document, s)));
      await invalidatePublications(tx, scope.businessId, row.itemId);
      await tx.videoStoryboard.update({ where: { id: row.id }, data: { status: "SUPERSEDED" } });
      const next = await tx.videoStoryboard.create({ data: { businessId: scope.businessId, organizationId: scope.organizationId, itemId: row.itemId, copyRevisionId: row.copyRevisionId, brandVersion: row.brandVersion, version: row.version + 1, document: input.document, shotApprovals: approvals, authorId: scope.actorId } });
      await storyboardContext(scope, next.id, tx);
      if (weekly) await tx.weeklyTask.update({ where: { id: weekly.task.id }, data: { storyboardId: next.id, videoStatus: "REVIEW" } });
      await tx.motionRender.updateMany({ where: { storyboardId: row.id, status: "QUEUED" }, data: { status: "CANCELLED", bytes: 0, leaseUntil: null } });
      await audit("STORYBOARD_VERSIONED", "Changed shots require fresh review. Unchanged shot approvals retained; assembled output invalidated."); return { ok: true, storyboardId: next.id };
    }
    if (input.action === "review-shot") {
      const shot = ctx.document.shots.find(s => s.id === input.shotId); if (!shot) throw new AppError(404, "Shot not found.");
      await assertReviewer(tx, scope, business.independentApproval, row.authorId);
      const reviews = shotApprovals.parse(row.shotApprovals).filter(a => a.shotId !== shot.id);
      if (input.approved) reviews.push({ shotId: shot.id, hash: shotHash(ctx.document, shot), reviewer: scope.actorId, at: new Date().toISOString() });
      await tx.videoStoryboard.update({ where: { id: row.id }, data: { shotApprovals: reviews, status: "DRAFT", approvedBy: null } });
      await tx.motionRender.updateMany({ where: { storyboardId: row.id, status: "APPROVED" }, data: { status: "READY", approvedBy: null } });
      await invalidatePublications(tx, scope.businessId, row.itemId);
      await audit("SHOT_REVIEWED", "Exact scene review saved; final storyboard approval required."); return { ok: true };
    }
    const approvals = shotApprovals.parse(row.shotApprovals);
    if (ctx.document.shots.some(shot => !approvals.some(a => a.shotId === shot.id && a.hash === shotHash(ctx.document, shot)))) throw new AppError(409, "Review every current shot before approving or rendering.");
    if (input.action === "approve-storyboard") {
      await assertReviewer(tx, scope, business.independentApproval, row.authorId);
      if (row.copyRevisionId) await assertNoBlockingComments(tx, row.copyRevisionId);
      await tx.videoStoryboard.update({ where: { id: row.id }, data: { status: "APPROVED", approvedBy: scope.actorId } });
      await audit("STORYBOARD_APPROVED", "Exact storyboard approved for bounded local rendering, not publication."); return { ok: true };
    }
    if (row.status !== "APPROVED") throw new AppError(409, "Approve this storyboard before rendering.");
    const existing = await tx.motionRender.findUnique({ where: { storyboardId_rendererVersion: { storyboardId: row.id, rendererVersion: MOTION_RENDERER_VERSION } } });
    if (existing) {
      if (weekly) await tx.weeklyTask.update({ where: { id: weekly.task.id }, data: { renderId: existing.id, videoStatus: "RENDERED" } });
      return { ok: true, renderId: existing.id };
    }
    if (ctx.document.soundtrack) requireAudioProcessing();
    const dailyLimit = motionDailyLimit(); storage();
    if (!await tx.workerHeartbeat.findFirst({ where: { runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), motionReady: true, lastSeenAt: { gt: new Date(Date.now() - HEARTBEAT_TTL_MS) } } })) throw new AppError(503, "A matching motion-render worker is not ready. No render was queued.");
    const usage = await tx.motionRender.aggregate({ where: { businessId: scope.businessId, status: { notIn: ["DELETED", "CANCELLED"] } }, _sum: { bytes: true }, _count: true });
    if (usage._count >= 10 || (usage._sum.bytes || 0) + MAX_VIDEO_BYTES > 100 * 1024 * 1024) throw new AppError(409, "Private video allowance reached (100 MB or ten renders). Remove unused output and allow retention cleanup.");
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    if (await tx.motionRender.count({ where: { businessId: scope.businessId, createdAt: { gte: today } } }) >= 6) throw new AppError(429, "Pilot motion rendering is limited to six requests per business per day.");
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(71403219)::text`;
    if (await tx.motionAuthorization.count({ where: { createdAt: { gte: today } } }) >= dailyLimit) throw new AppError(409, "The operator's daily motion-render limit is reached.");
    const id = randomUUID(); await tx.motionAuthorization.create({ data: { key: id } });
    const render = await tx.motionRender.create({ data: { id, businessId: scope.businessId, organizationId: scope.organizationId, storyboardId: row.id, rendererVersion: MOTION_RENDERER_VERSION, documentHash: motionHash(ctx.document), objectKey: `${scope.organizationId}/${scope.businessId}/motion/${id}.mp4`, bytes: MAX_VIDEO_BYTES, durationMs: totalDuration(ctx.document), createdBy: scope.actorId, purgeAfter: new Date(Date.now() + 30 * 86400000) } });
    const layout = videoLayout(ctx.document);
    if (weekly) await tx.weeklyTask.update({ where: { id: weekly.task.id }, data: { renderId: render.id, videoStatus: "RENDERED" } });
    await audit("MOTION_QUEUED", `Bounded ${ctx.document.soundtrack ? "instrumental" : "silent"} ${layout.width}×${layout.height} render authorized. No AI credits charged; server CPU/storage limits apply.`); return { ok: true, renderId: render.id };
  });
}
export async function motionMetadata(scope: Scope, id: string, download: boolean) {
    if (!await db.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } })) throw new AppError(404, "Workspace not found.");
    const row = await db.motionRender.findFirst({ where: { id, businessId: scope.businessId, organizationId: scope.organizationId, status: { in: download ? ["APPROVED"] : ["READY", "APPROVED", "REJECTED"] }, purgeAfter: { gt: new Date() } } });
    if (!row) throw new AppError(404, "Video unavailable or awaiting approval.");
    const ctx = await storyboardContext(scope, row.storyboardId);
    if (ctx.row.status !== "APPROVED" || motionHash(ctx.document) !== row.documentHash || row.rendererVersion !== MOTION_RENDERER_VERSION) throw new AppError(409, "Review and render the current storyboard.");
    return { row, document: ctx.document };
}
export async function readMotion(scope: Scope, id: string, download: boolean, store: AssetStore = videoStore()) {
  const context = await motionMetadata(scope, id, download), bytes = await store.get(context.row.objectKey);
  if (bytes.length !== context.row.bytes || bytes.length > MAX_VIDEO_BYTES || createHash("sha256").update(bytes).digest("hex") !== context.row.sha256) throw new AppError(409, "Video storage integrity check failed.");
  await motionMetadata(scope, id, download); return { bytes, document: context.document };
}
