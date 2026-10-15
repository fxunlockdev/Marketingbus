import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { lockBusiness } from "../production/service";
import { assertExecutionEnabled } from "../production/router";
import { assertBrandEditor } from "../knowledge/analysis";
import { finishReservationInTransaction } from "../billing/wallet";
import { assetStore, type AssetStore } from "../assets/storage";
import { normalizeImage } from "../assets/images";
import { generateGeminiImage, type ImageGenerator, type ImageResult } from "../providers/gemini-image";
import { imageConfigurationHash, imageCost, imageRoute } from "./contracts";
import { currentImageContext, imageScope } from "./service";

export async function runOneImage(generate: ImageGenerator = generateGeminiImage, storage: () => AssetStore = assetStore) {
  const claimed = await db.$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "ImageGeneration" WHERE status='QUEUED' ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!rows[0]) return null;
    return tx.imageGeneration.update({ where: { id: rows[0].id }, data: { status: "RUNNING", leaseUntil: new Date(Date.now() + 300000) } });
  });
  if (!claimed) return false;
  const scope = imageScope(claimed); let submitted = false, result: ImageResult | null = null, cost: number | null = null;
  try {
    const store = storage();
    const preflight = () => db.$transaction(async tx => {
      await lockBusiness(tx, scope); await assertBrandEditor(tx, scope); assertExecutionEnabled();
      const row = await tx.imageGeneration.findUniqueOrThrow({ where: { id: claimed.id }, include: { output: true } });
      const route = imageRoute.parse(row.route);
      if (row.status !== "RUNNING" || row.leaseUntil?.getTime() !== claimed.leaseUntil?.getTime() || row.leaseUntil!.getTime() <= Date.now() || row.configurationHash !== imageConfigurationHash() || !process.env.GEMINI_API_KEY || new Date(route.model.verifiedUntil).getTime() <= Date.now() || row.output?.status !== "PENDING") throw Error("Image preflight changed");
      const context = await currentImageContext(tx, row); return { row, route, context };
    });
    const request = await preflight(), references: Buffer[] = [];
    // Preserve the quoted reference ordering, including the parent last for a revision.
    const refs = request.row.references as { id: string; sha256: string }[];
    for (const ref of refs) {
      const asset = request.context.assets.find(a => a.id === ref.id)!;
      const bytes = Buffer.from(await store.get(asset.objectKey));
      if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw Error("Reference integrity failed");
      references.push(bytes);
    }
    // Recheck permissions after slow storage reads, and fence before the only network submit.
    await preflight();
    await db.$transaction(async tx => {
      await lockBusiness(tx, scope); await assertBrandEditor(tx, scope); assertExecutionEnabled();
      const row = await tx.imageGeneration.findUniqueOrThrow({ where: { id: claimed.id } });
      if (row.status !== "RUNNING" || row.leaseUntil?.getTime() !== claimed.leaseUntil?.getTime() || row.leaseUntil!.getTime() <= Date.now() || row.configurationHash !== imageConfigurationHash()) throw Error("Image lease changed");
      await currentImageContext(tx, row);
      await tx.imageGeneration.update({ where: { id: row.id }, data: { status: "SUBMITTING", submittedAt: new Date() } });
    });
    submitted = true;
    result = await generate({ prompt: request.row.prompt, route: request.route, references }, process.env.GEMINI_API_KEY!);
    cost = imageCost(request.route, result.usage);
    if (!result.image) throw Error("Provider returned no eligible still image");
    const normalized = await normalizeImage(result.image), asset = request.row.output!;
    await db.$transaction(async tx => {
      await lockBusiness(tx, scope);
      const row = await tx.imageGeneration.findUniqueOrThrow({ where: { id: claimed.id } });
      if (row.status !== "SUBMITTING") throw Error("Image requires reconciliation");
      await currentImageContext(tx, row); await assertBrandEditor(tx, scope);
      // Persist expected hash before immutable upload. PENDING objects are never served.
      await tx.brandAsset.update({ where: { id: asset.id }, data: { sha256: normalized.sha256, width: normalized.width, height: normalized.height } });
    });
    await store.put(asset.objectKey, normalized.data, "image/webp", true);
    if (createHash("sha256").update(await store.get(asset.objectKey)).digest("hex") !== normalized.sha256) throw Error("Generated storage verification failed");
    await db.$transaction(async tx => {
      await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
      const row = await tx.imageGeneration.findUniqueOrThrow({ where: { id: claimed.id } });
      if (row.status !== "SUBMITTING") throw Error("Image requires reconciliation");
      await currentImageContext(tx, row);
      await finishReservationInTransaction(tx, scope.organizationId, row.reservationId!, Math.max(1, Math.ceil(cost! / 10000)));
      await tx.brandAsset.update({ where: { id: asset.id }, data: { status: "READY", bytes: normalized.bytes, approvedForGeneration: false } });
      await tx.imageGeneration.update({ where: { id: row.id }, data: { status: "READY", leaseUntil: null, providerResponseId: result!.id, usage: result!.usage as Prisma.InputJsonValue, supplierCostMicros: cost } });
      await tx.auditEvent.create({ data: { ...scope, action: "IMAGE_READY", detail: "Private image decoded, normalized and storage-verified. Credits settled against measured usage. Human visual/fidelity review required before composition." } });
    });
  } catch {
    await db.$transaction(async tx => {
      await lockBusiness(tx, scope);
      const row = await tx.imageGeneration.findUniqueOrThrow({ where: { id: claimed.id }, include: { output: true } });
      if (!["RUNNING", "SUBMITTING", "NEEDS_RECONCILIATION"].includes(row.status)) return;
      if (!submitted && row.leaseUntil?.getTime() !== claimed.leaseUntil?.getTime()) return;
      const ambiguous = (submitted || row.status !== "RUNNING") && cost === null;
      if (!ambiguous) await finishReservationInTransaction(tx, scope.organizationId, row.reservationId!, 0);
      if (row.output && !ambiguous) await tx.brandAsset.update({ where: { id: row.output.id }, data: submitted ? { status: "ARCHIVED", archivedFromStatus: "FAILED", archivedAt: new Date(), purgeAfter: new Date(Date.now() + 7 * 86400000), approvedForGeneration: false } : { status: "DELETED", bytes: 0 } });
      await tx.imageGeneration.update({ where: { id: row.id }, data: { status: ambiguous ? "NEEDS_RECONCILIATION" : "FAILED", leaseUntil: null, errorCode: ambiguous ? "PROVIDER_OUTCOME_UNKNOWN" : submitted ? "OUTPUT_NOT_DELIVERABLE" : "PREFLIGHT_FAILED", ...(cost !== null ? { supplierCostMicros: cost, providerResponseId: result?.id, usage: result!.usage as Prisma.InputJsonValue } : {}) } });
      await tx.auditEvent.create({ data: { ...scope, action: "IMAGE_STOPPED", detail: ambiguous ? "Uncertain supplier outcome. Hold retained; no automatic resubmission." : "No image delivered. Customer hold released; known supplier expense recorded and uncertain stored objects quarantined for deletion." } });
    });
  }
  return true;
}
export async function recoverImageLeases() {
  const rows = await db.imageGeneration.findMany({ where: { status: { in: ["RUNNING", "SUBMITTING"] }, leaseUntil: { lt: new Date() } }, take: 50 });
  for (const row of rows) await db.$transaction(async tx => {
    await lockBusiness(tx, imageScope(row));
    await tx.imageGeneration.updateMany({ where: { id: row.id, status: row.status, leaseUntil: { lt: new Date() } }, data: { status: row.status === "RUNNING" ? "QUEUED" : "NEEDS_RECONCILIATION", leaseUntil: null, errorCode: row.status === "RUNNING" ? null : "LEASE_EXPIRED_AFTER_SUBMISSION" } });
  });
}
