import { db } from "../db";
import { lockBusiness } from "../production/service";
import { manageVideo, storyboardContext, videoStore } from "../video/service";
import { manageShotGeneration } from "../video/generation-service";
import { activeShots, configuredShotAdapters, type ShotAdapter } from "../video/generation-contracts";
import { weeklyVideoContext, stopWeeklyVideos } from "./weekly-video-policy";
import { weekKey } from "./planning";
import type { AssetStore } from "../assets/storage";
import { DEFAULT_CLIP_EDIT } from "../video/document";

// One bounded transition per business, then yield to other businesses. Provider I/O
// stays in the existing durable shot worker; this lane never approves or publishes.
export async function runOneWeeklyVideo(options: {
  video?: typeof manageVideo; shot?: typeof manageShotGeneration;
  adapters?: ShotAdapter[]; storage?: () => AssetStore;
} = {}) {
  const now = new Date();
  const candidate = await db.weeklyCycle.findFirst({ where: { videoStatus: "OPEN", AND: [
    { OR: [{ videoLeaseUntil: null }, { videoLeaseUntil: { lt: now } }] },
    { OR: [{ nextVideoAt: null }, { nextVideoAt: { lte: now } }] },
  ] }, orderBy: [{ nextVideoAt: "asc" }, { createdAt: "asc" }, { id: "asc" }] });
  if (!candidate) return false;
  const leaseUntil = new Date(Date.now() + 120000);
  if (!(await db.weeklyCycle.updateMany({ where: { id: candidate.id, videoStatus: "OPEN", AND: [
    { OR: [{ videoLeaseUntil: null }, { videoLeaseUntil: { lt: new Date() } }] },
    { OR: [{ nextVideoAt: null }, { nextVideoAt: { lte: new Date() } }] },
  ] }, data: { videoLeaseUntil: leaseUntil } })).count) return true;
  let selectedTaskId: string | undefined;
  const policy = await db.weeklyPolicy.findUnique({ where: { businessId: candidate.businessId } });
  const scope = { businessId: candidate.businessId, organizationId: candidate.organizationId, actorId: policy?.actorId ?? "weekly-worker" };
  try {
    const work = await db.$transaction(async tx => {
      const business = await lockBusiness(tx, scope);
      const cycle = await tx.weeklyCycle.findUniqueOrThrow({ where: { id: candidate.id } });
      if (cycle.videoStatus !== "OPEN" || cycle.videoLeaseUntil?.getTime() !== leaseUntil.getTime() || leaseUntil <= new Date()) return null;
      const fresh = await tx.weeklyPolicy.findUnique({ where: { businessId: scope.businessId } });
      const member = fresh && await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: fresh.actorId } } });
      if (!fresh?.enabled || fresh.mode !== "DRAFTS" || !fresh.videosAfterApproval || fresh.actorId !== scope.actorId || fresh.version !== cycle.policyVersion ||
        !business.confirmedAt || business.version !== cycle.brandVersion || fresh.brandVersion !== business.version ||
        !member || !["OWNER", "ADMIN"].includes(member.role) || !["OPEN", "COMPLETE"].includes(cycle.status) || cycle.periodKey !== weekKey(new Date())) {
        await stopWeeklyVideos(tx, scope, [cycle.id]); return null;
      }
      await tx.weeklyCycle.update({ where: { id: cycle.id }, data: { videoLeaseUntil: leaseUntil, nextVideoAt: new Date(Date.now() + 300000) } });
      const tasks = await tx.weeklyTask.findMany({ where: { cycleId: cycle.id, videoStatus: { in: ["WAITING", "STORYBOARD", "PRODUCING", "REVIEW"] } }, include: { shots: true }, orderBy: { id: "asc" }, take: 12 });
      if (!tasks.length) {
        await tx.weeklyCycle.update({ where: { id: cycle.id }, data: { videoStatus: "COMPLETE", videoLeaseUntil: null, nextVideoAt: null } }); return null;
      }
      for (const task of tasks) {
        if (task.status !== "AUTHORIZED") continue;
        const quote = task.quoteId && await tx.generationQuote.findFirst({ where: { id: task.quoteId, itemId: task.itemId,
          organizationId: scope.organizationId, businessId: scope.businessId }, include: { job: true } });
        if (!quote || !quote.job || ["FAILED", "CANCELLED", "NEEDS_RECONCILIATION"].includes(quote.job.status)) {
          if (quote && quote.job) await tx.weeklyTask.update({ where: { id: task.id }, data: { videoStatus: "STOPPED" } });
          continue;
        }
        if (quote.job.status !== "COMPLETED") continue;
        const latestCopy = await tx.creativeRevision.findFirst({ where: { itemId: task.itemId, organizationId: scope.organizationId }, orderBy: { version: "desc" } });
        if (latestCopy?.status !== "APPROVED") continue;
        const internal = { taskId: task.id, leaseUntil };
        await weeklyVideoContext(tx, scope, internal);
        selectedTaskId = task.id;
        const latest = await tx.videoStoryboard.findFirst({ where: { itemId: task.itemId, businessId: scope.businessId, organizationId: scope.organizationId }, orderBy: { version: "desc" } });
        if (!task.storyboardId) {
          if (latest) { await tx.weeklyTask.update({ where: { id: task.id }, data: { videoStatus: "SKIPPED" } }); continue; }
          return { kind: "create" as const, internal, itemId: task.itemId };
        }
        if (!latest) throw Error("Weekly storyboard missing");
        // Edits before the first paid scene are expected. After authorization, do
        // not reinterpret paid work against a different storyboard or copy.
        if (latest.id !== task.storyboardId) {
          if (task.shots.length || task.videoStatus === "REVIEW") throw Error("Weekly storyboard superseded after generation");
          await storyboardContext(scope, latest.id, tx);
          await tx.weeklyTask.update({ where: { id: task.id }, data: { storyboardId: latest.id } });
        }
        const ctx = await storyboardContext(scope, latest.id, tx);
        if (ctx.row.status !== "APPROVED") continue;
        const jobs = await tx.videoGeneration.findMany({ where: { id: { in: task.shots.map(s => s.generationId) },
          itemId: task.itemId, businessId: scope.businessId, organizationId: scope.organizationId }, include: { output: true } });
        if (jobs.length !== task.shots.length || jobs.some(j => ["FAILED", "CANCELLED", "NEEDS_RECONCILIATION"].includes(j.status) ||
          j.output && ["REJECTED", "ARCHIVED", "DELETING", "DELETED", "FAILED"].includes(j.output.status))) throw Error("Weekly shot needs human recovery");
        if (jobs.some(j => activeShots.includes(j.status))) continue;
        if (task.videoStatus === "REVIEW") return { kind: "render" as const, internal, storyboardId: latest.id };
        const empty = ctx.document.shots.filter(s => !s.asset && !s.clip);
        const unrelated = await tx.videoGeneration.count({ where: { itemId: task.itemId, id: { notIn: task.shots.map(s => s.generationId) } } });
        if (unrelated) throw Error("Manual shot work requires explicit continuation");
        const offered = jobs.find(j => j.status === "OFFERED");
        const missing = empty.find(s => !task.shots.some(link => link.shotId === s.id));
        if (offered || missing) {
          if (await tx.videoGeneration.count({ where: { businessId: scope.businessId, status: { in: activeShots } } })) continue;
          return { kind: "shot" as const, internal, storyboardId: latest.id, shotId: offered?.shotId ?? missing!.id, generationId: offered?.id };
        }
        if (empty.length) {
          if (empty.some(s => !jobs.some(j => j.shotId === s.id && j.status === "READY" && j.output?.status === "APPROVED"))) continue;
          const document = { ...ctx.document, shots: ctx.document.shots.map(s => {
            if (s.asset || s.clip) return s;
            const clip = jobs.find(j => j.shotId === s.id)!.output!;
            return { ...s, clip: { id: clip.id, sha256: clip.sha256 }, clipEdit: DEFAULT_CLIP_EDIT };
          }) };
          return { kind: "assemble" as const, internal, storyboardId: latest.id, document };
        }
        return { kind: "render" as const, internal, storyboardId: latest.id };
      }
      return null;
    });
    if (!work) return true;
    const video = options.video ?? manageVideo, storage = options.storage ?? videoStore;
    if (work.kind === "create") await video(scope, { action: "create", itemId: work.itemId }, storage, work.internal);
    else if (work.kind === "assemble") await video(scope, { action: "save", storyboardId: work.storyboardId, document: work.document }, storage, work.internal);
    else if (work.kind === "render") await video(scope, { action: "render", storyboardId: work.storyboardId }, storage, work.internal);
    else {
      const shot = options.shot ?? manageShotGeneration, adapters = options.adapters ?? configuredShotAdapters();
      const generationId = work.generationId ?? (await shot(scope, { action: "quote", storyboardId: work.storyboardId, shotId: work.shotId }, adapters, storage, work.internal)).generationId;
      if (!generationId) throw Error("Missing recurring video offer");
      await shot(scope, { action: "accept", generationId, rightsConfirmed: true }, adapters, storage, work.internal);
    }
  } catch {
    await db.$transaction(async tx => {
      await lockBusiness(tx, scope);
      if (!await tx.weeklyCycle.findFirst({ where: { id: candidate.id, videoStatus: "OPEN", videoLeaseUntil: { equals: leaseUntil, gt: new Date() } } })) return;
      await stopWeeklyVideos(tx, scope, [candidate.id]);
      if (selectedTaskId) await tx.weeklyTask.updateMany({ where: { id: selectedTaskId, videoStatus: "CANCELLED" }, data: { videoStatus: "STOPPED" } });
      await tx.weeklyCycle.update({ where: { id: candidate.id }, data: { videoStatus: "BLOCKED" } });
      await tx.auditEvent.create({ data: { ...scope, action: "WEEKLY_VIDEO_BLOCKED", detail: "No further video authorization. Review source approvals, retained media, provider configuration and shared weekly credit ceiling. Accepted jobs and holds are unchanged; never retry ambiguous submissions." } });
    });
  } finally { await db.weeklyCycle.updateMany({ where: { id: candidate.id, videoLeaseUntil: leaseUntil }, data: { videoLeaseUntil: null } }); }
  return true;
}
