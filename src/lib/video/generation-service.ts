import { randomUUID } from "node:crypto";
import { checkCreativeRevision, isMediaRevision } from "../production/revision-limit";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../http";
import { lockBusiness, type Scope } from "../production/service";
import { assertBrandEditor } from "../knowledge/analysis";
import { assertExecutionEnabled } from "../production/router";
import { assertWorkerReady, WORKER_RUNTIME, HEARTBEAT_TTL_MS, workerConfigurationHash } from "../production/readiness";
import { authorizeSupplier } from "../production/budget";
import { reserveCreditsInTransaction, finishReservationInTransaction } from "../billing/wallet";
import { storyboardContext, shotHash, videoStore } from "./service";
import { shotApprovals } from "./document";
import { motionHash, motionDailyLimit } from "./limits";
import { CLIP_PROCESSOR_VERSION } from "./clip-normalizer";
import { activeShots, configuredShotAdapters, selectShotRoute, shotConfigurationHash, SHOT_HARNESS, type ShotAdapter, shotRoute, shotAdapter } from "./generation-contracts";
import { assertShotContext, assertShotRevisionSource } from "./generation-context";
import type { AssetStore } from "../assets/storage";
import { nextShotBrief, readShotBrief, shotDirection, shotFeedback, type ShotCreativeBrief } from "./creative-brief";
import { weeklyVideoContext, reserveWeeklyVideo, type WeeklyVideoAuthorization } from "../workflows/weekly-video-policy";

const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("quote"), storyboardId: z.string().min(1).max(100), shotId: z.string().min(1).max(60), direction: shotDirection.optional(), revisionOfId: z.string().min(1).max(100).optional(), feedback: shotFeedback.optional() }).strict()
    .refine(v => v.revisionOfId ? !!v.feedback && v.direction === undefined : v.feedback === undefined, "New takes require feedback and retain their original direction; initial shots cannot include revision feedback."),
  z.object({ action: z.literal("accept"), generationId: z.string().min(1).max(100), rightsConfirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal("cancel"), generationId: z.string().min(1).max(100) }).strict(),
]);
export async function listShotGenerations(scope: Scope) {
  const member = await db.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
  if (!member || !await db.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId } })) throw new AppError(404, "Business not found.");
  return { canEdit: ["OWNER", "ADMIN", "EDITOR"].includes(member.role), integrationAvailable: configuredShotAdapters().length > 0, jobs: await db.videoGeneration.findMany({
    where: { businessId: scope.businessId, organizationId: scope.organizationId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50,
    select: { id: true, storyboardId: true, itemId: true, shotId: true, shotLabel: true, durationMs: true, status: true, credits: true, expiresAt: true, errorCode: true, createdAt: true, revisionOfId: true, creativeBrief: true, output: { select: { id: true, status: true } } },
  }).then(jobs => jobs.map(job => ({ ...job, creativeBrief: readShotBrief(job.creativeBrief) }))) };
}
export async function manageShotGeneration(scope: Scope, raw: unknown, adapters: ShotAdapter[] = configuredShotAdapters(), storage: () => AssetStore = videoStore, internal?: WeeklyVideoAuthorization) {
  const input = action.parse(raw);
  return db.$transaction(async tx => {
    await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
    const audit = (event: string, detail: string) => tx.auditEvent.create({ data: { ...scope, action: event, detail } });
    if (input.action === "quote") {
      const ctx = await storyboardContext(scope, input.storyboardId, tx), shot = ctx.document.shots.find(s => s.id === input.shotId);
      if (await isMediaRevision(tx, scope, ctx.row.itemId, "video", input.revisionOfId, input.shotId)) await checkCreativeRevision(tx, scope, ctx.row.itemId);
      const weekly = internal ? await weeklyVideoContext(tx, scope, internal) : null;
      if (weekly && (weekly.task.storyboardId !== input.storyboardId || weekly.task.itemId !== ctx.row.itemId || input.revisionOfId || weekly.task.shots.some(s => s.shotId === input.shotId))) throw new AppError(409, "Recurring video cannot replace or repeat an existing scene authorization.");
      if (!shot || ctx.row.status !== "APPROVED" || !ctx.row.approvedBy || !shotApprovals.parse(ctx.row.shotApprovals).some(a => a.shotId === shot.id && a.hash === shotHash(ctx.document, shot))) throw new AppError(409, "Save and approve the exact storyboard and shot before requesting footage.");
      let creativeBrief: ShotCreativeBrief = { version: 1, direction: input.direction ?? "", revisions: [] };
      if (input.revisionOfId) {
        const parent = await assertShotRevisionSource(tx, { revisionOfId: input.revisionOfId, businessId: scope.businessId, organizationId: scope.organizationId, itemId: ctx.row.itemId, copyRevisionId: ctx.row.copyRevisionId, brandVersion: ctx.business.version, shotId: shot.id });
        if (shot.asset || shot.clip && shot.clip.id !== parent.output!.id) throw new AppError(409, "Choose an empty scene or the exact source take. Other imagery and footage cannot be silently replaced.");
        creativeBrief = nextShotBrief(parent.id, parent.creativeBrief, input.feedback!);
      } else if (shot.asset || shot.clip) throw new AppError(409, "This generation lane creates supporting footage for an empty scene. Select a completed take to request feedback-driven regeneration.");
      const route = selectShotRoute(shot.durationMs, adapters);
      assertExecutionEnabled(); await assertWorkerReady(tx); storage();
      if (await tx.videoGeneration.count({ where: { businessId: scope.businessId, status: { in: activeShots } } })) throw new AppError(409, "Resolve the current generated-shot job first.");
      if (await tx.videoGeneration.count({ where: { businessId: scope.businessId, createdAt: { gt: new Date(Date.now() - 86400000) } } }) >= 24) throw new AppError(429, "Video quotes are limited to 24 per business per day.");
      const prompt = SHOT_HARNESS + "\nBRIEF DATA:\n" + JSON.stringify({ business: ctx.business.name, offering: ctx.business.offering, audience: ctx.business.audience, tone: ctx.business.tone, restrictions: ctx.business.restrictions, contentPreferences: ctx.business.contentPreferences, palette: ctx.document.background, scene: { label: shot.label, purpose: shot.caption }, durationMs: route.durationMs, creativeDirection: creativeBrief.direction, feedback: creativeBrief.revisions.map(r => r.feedback) });
      if (Buffer.byteLength(prompt) > 12000) throw new AppError(400, "The combined brand, direction and feedback exceed the prompt limit. Shorten this request or deliberately start a new direction.");
      await tx.videoGeneration.updateMany({ where: { businessId: scope.businessId, storyboardId: ctx.row.id, shotId: shot.id, status: "OFFERED" }, data: { status: "CANCELLED" } });
      const row = await tx.videoGeneration.create({ data: { ...scope, storyboardId: ctx.row.id, itemId: ctx.row.itemId, copyRevisionId: ctx.row.copyRevisionId, brandVersion: ctx.business.version, shotId: shot.id, shotLabel: shot.label, documentHash: motionHash(ctx.document), prompt, creativeBrief, revisionOfId: input.revisionOfId ?? null, route, configurationHash: shotConfigurationHash(), durationMs: route.durationMs, credits: route.credits, supplierCeilingMicros: route.ceilingMicros, expiresAt: new Date(Date.now() + 600000) } });
      if (weekly) await tx.weeklyVideoShot.create({ data: { taskId: weekly.task.id, shotId: shot!.id, generationId: row.id } });
      await audit("SHOT_QUOTED", input.revisionOfId ? "Feedback-driven new take quoted against an approved scene. Prior media is not sent, altered or automatically replaced. No credits reserved." : "Directed supporting footage quoted against an approved scene. No credits reserved and no provider call.");
      return { ok: true, generationId: row.id };
    }
    const row = await tx.videoGeneration.findFirst({ where: { id: input.generationId, businessId: scope.businessId, organizationId: scope.organizationId }, include: { output: true } });
    if (!row) throw new AppError(404, "Generated-shot job not found.");
    if (input.action === "cancel") {
      if (row.status === "CANCELLED") return { ok: true };
      if (!["OFFERED", "QUEUED", "RUNNING"].includes(row.status)) throw new AppError(409, "Submission has started. Uncertain jobs require operator reconciliation, never another submission.");
      if (row.reservationId) await finishReservationInTransaction(tx, scope.organizationId, row.reservationId, 0);
      await tx.videoGeneration.update({ where: { id: row.id }, data: { status: "CANCELLED", leaseUntil: null } });
      if (row.output) await tx.videoClip.update({ where: { id: row.output.id }, data: { status: "DELETED", bytes: 0, leaseUntil: null } });
      await audit("SHOT_CANCELLED", "Cancelled before supplier submission. Customer credits released; supplier admission is not replenished."); return { ok: true };
    }
    if (row.acceptedAt) return { ok: true };
    if (!internal && await tx.weeklyVideoShot.findUnique({ where: { generationId: row.id } })) throw new AppError(409, "This offer belongs to recurring authorization. Let the weekly run apply its shared credit ceiling, or stop that run.");
    const route = shotRoute.parse(row.route); shotAdapter(route, adapters);
    assertExecutionEnabled(); await assertWorkerReady(tx); const daily = motionDailyLimit(); storage();
    if (row.status !== "OFFERED" || row.expiresAt <= new Date() || row.configurationHash !== shotConfigurationHash() || new Date(route.verifiedUntil) <= new Date()) throw new AppError(409, "Video quote expired or configuration changed.");
    await assertShotContext(tx, row);
    if (await tx.videoGeneration.count({ where: { businessId: scope.businessId, status: { in: activeShots } } })) throw new AppError(409, "Resolve the current generated-shot job first.");
    if (!await tx.workerHeartbeat.findFirst({ where: { runtimeVersion: WORKER_RUNTIME, configurationHash: workerConfigurationHash(), motionReady: true, lastSeenAt: { gt: new Date(Date.now() - HEARTBEAT_TTL_MS) } } })) throw new AppError(503, "A matching footage-normalization worker is required before spending.");
    if (await tx.videoClip.count({ where: { businessId: scope.businessId, status: { not: "DELETED" } } }) >= 5) throw new AppError(409, "Five private clips are already retained. Allow retention cleanup before generation.");
    const day = new Date(); day.setUTCHours(0, 0, 0, 0);
    if (await tx.videoClip.count({ where: { businessId: scope.businessId, createdAt: { gte: day } } }) >= 6) throw new AppError(429, "Six uploaded or generated clips per business per day are allowed.");
    if (internal) await reserveWeeklyVideo(tx, scope, row, internal);
    if (await isMediaRevision(tx, scope, row.itemId, "video", row.revisionOfId, row.shotId)) await checkCreativeRevision(tx, scope, row.itemId, true);
    await authorizeSupplier(tx, row.id, row.supplierCeilingMicros);
    const hold = await reserveCreditsInTransaction(tx, scope.organizationId, row.id, row.credits);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(71403219)::text`;
    if (await tx.motionAuthorization.count({ where: { createdAt: { gte: day } } }) >= daily) throw new AppError(409, "The operator's daily video processing limit is reached.");
    const clipId = randomUUID(); await tx.motionAuthorization.create({ data: { key: clipId } });
    const brief = readShotBrief(row.creativeBrief);
    await tx.videoClip.create({ data: { id: clipId, generationId: row.id, businessId: row.businessId, organizationId: row.organizationId, brandVersion: row.brandVersion, label: `Generated · ${row.shotLabel.slice(0, 48)} · take ${brief.revisions.length + 1} · ${row.id.slice(-6)}`, createdBy: scope.actorId, rightsConfirmedAt: new Date(), status: "AWAITING_GENERATION", sourceKey: `${row.organizationId}/${row.businessId}/clips/${clipId}-source.mp4`, objectKey: `${row.organizationId}/${row.businessId}/clips/${clipId}.mp4`, sourceHash: "", sourceBytes: 0, processorVersion: CLIP_PROCESSOR_VERSION, purgeAfter: new Date(Date.now() + 30 * 86400000) } });
    await tx.videoGeneration.update({ where: { id: row.id }, data: { status: "QUEUED", acceptedAt: new Date(), actorId: scope.actorId, reservationId: hold.id } });
    await audit("SHOT_AUTHORIZED", `At most ${row.credits} credits reserved for one submission. Storage and normalization allowance reserved; human review required.`);
    return { ok: true };
  });
}
