import { payloadHash } from "./integrity";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError } from "../http";
import { sealSecret } from "../secrets";
import { currentItem, lockBusiness, type Scope } from "../production/service";
import { creativeSchema } from "../production/content";
import { publicationExport } from "./image-transfer";
import { assertBrandEditor } from "../knowledge/analysis";
import { approvedFactText, evaluateCreative } from "../production/quality";
import {
  publicationPayload,
  socialProvider,
  type SocialAdapters,
} from "./contracts";

export const socialAction = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("schedule"),
      itemId: z.string().min(1),
      version: z.number().int().positive(),
      connectionId: z.string().min(1),
      scheduledFor: z.iso.datetime(),
      timezone: z.string().min(1).max(80),
      mediaExportId: z.string().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("cancel"), publicationId: z.string().min(1) })
    .strict(),
]);
export async function assertNoPublicationInFlight(
  tx: Prisma.TransactionClient,
  businessId: string,
  itemId?: string
) {
  if (
    await tx.socialPublication.count({
      where: {
        businessId,
        ...(itemId ? { revision: { itemId } } : {}),
        status: { in: ["SUBMITTING", "NEEDS_RECONCILIATION"] },
      },
    })
  )
    throw new AppError(
      409,
      "A social post is submitting or has an uncertain outcome. Resolve it before changing this work."
    );
}
export async function invalidatePublications(
  tx: Prisma.TransactionClient,
  businessId: string,
  itemId?: string
) {
  await assertNoPublicationInFlight(tx, businessId, itemId);
  await tx.socialPublication.updateMany({
    where: {
      businessId,
      ...(itemId ? { revision: { itemId } } : {}),
      status: "SCHEDULED",
    },
    data: { status: "CANCELLED", errorCode: "APPROVAL_CHANGED" },
  });
}

// Server-only completion hook for a verified OAuth exchange. No generic token-ingestion HTTP route.
// Callers must verify one-use state, session, account ownership and granted scopes first.
export async function saveVerifiedConnection(scope: Scope, raw: unknown) {
  return db.$transaction(async (tx) => {
    await lockBusiness(tx, scope);
    return saveVerifiedConnectionInTransaction(tx, scope, raw);
  });
}
export async function saveVerifiedConnectionInTransaction(tx: Prisma.TransactionClient, scope: Scope, raw: unknown) {
  const input = z
    .object({
      provider: socialProvider,
      externalAccountId: z.string().min(1).max(200),
      label: z.string().min(1).max(120),
      token: z.string().min(1).max(20000),
      permissions: z.array(z.string().max(100)).max(30),
      expiresAt: z.date().nullable(),
    })
    .strict()
    .parse(raw);
    const existing = await tx.socialConnection.findUnique({
      where: {
        businessId_provider_externalAccountId: {
          businessId: scope.businessId,
          provider: input.provider,
          externalAccountId: input.externalAccountId,
        },
      },
    });
    if (existing && await tx.socialPublication.count({ where: { connectionId: existing.id,
      OR: [{ status: "SUBMITTING" }, { status: "NEEDS_RECONCILIATION", leaseUntil: { gt: new Date() } }] } }))
      throw new AppError(409, "Wait for the active account request to finish before reconnecting. Uncertain posts will not be resent.");
    const id = existing?.id ?? crypto.randomUUID();
    const encryptedToken = sealSecret(
      input.token,
      `social:${scope.organizationId}:${scope.businessId}:${id}`
    );
    const data = {
      dataSnapshot: Prisma.DbNull, dataFetchedAt: null, dataLeaseId: null, dataLeaseUntil: null, dataErrorCode: null,
      provider: input.provider,
      externalAccountId: input.externalAccountId,
      label: input.label,
      permissions: input.permissions,
      expiresAt: input.expiresAt,
      encryptedToken,
      status: "CONNECTED",
    };
    await tx.socialConnection.upsert({
      where: { id },
      create: {
        id,
        businessId: scope.businessId,
        organizationId: scope.organizationId,
        ...data,
      },
      update: { ...data, authorizationVersion: { increment: 1 } },
    });
    await tx.auditEvent.create({
      data: {
        ...scope,
        action: "SOCIAL_CONNECTED",
        detail: `${input.provider} account connected through a verified server-side exchange.`,
      },
    });
    return { id };
}
export async function manageSocial(
  scope: Scope,
  raw: unknown,
  adapters: SocialAdapters
) {
  const input = socialAction.parse(raw);
  return db.$transaction(async (tx) => {
    const business = await lockBusiness(tx, scope);
    await assertBrandEditor(tx, scope);
    if (input.action === "cancel") {
      const post = await tx.socialPublication.findFirst({
        where: {
          id: input.publicationId,
          businessId: scope.businessId,
          organizationId: scope.organizationId,
        },
      });
      if (!post) throw new AppError(404, "Publication not found.");
      if (!["SCHEDULED", "CANCELLED"].includes(post.status))
        throw new AppError(
          409,
          "This publication cannot be cancelled. Published posts require removal on the network; uncertain posts require reconciliation."
        );
      await tx.socialPublication.update({
        where: { id: post.id },
        data: { status: "CANCELLED" },
      });
    } else {
      const connection = await tx.socialConnection.findFirst({
        where: {
          id: input.connectionId,
          businessId: scope.businessId,
          organizationId: scope.organizationId,
        },
      });
      if (!connection) throw new AppError(404, "Social account not found.");
      {
        const provider = socialProvider.parse(connection.provider);
        if (!adapters[provider])
          throw new AppError(
            503,
            `${provider} publishing is not connected. No post was queued.`
          );
        if (
          connection.status !== "CONNECTED" ||
          (connection.expiresAt && connection.expiresAt <= new Date())
        )
          throw new AppError(
            409,
            "Reconnect this social account before scheduling."
          );
        const item = await currentItem(tx, scope, input.itemId),
          revision = item.revisions[0];
        if (
          !business.confirmedAt ||
          business.version !== item.plan.brandVersion ||
          item.plan.status !== "PROPOSED"
        )
          throw new AppError(
            409,
            "Confirm the current brand and create current work first."
          );
        if (
          !revision ||
          revision.version !== input.version ||
          revision.status !== "APPROVED"
        )
          throw new AppError(
            409,
            "Approve this exact current version before publishing."
          );
        if (item.channel !== provider)
          throw new AppError(
            400,
            "The account and creative must use the same platform."
          );
        const creative = creativeSchema.parse(revision.content);
        if (
          !evaluateCreative(creative, { facts: approvedFactText(business) })
            .eligible
        )
          throw new AppError(409, "Resolve factual checks before publishing.");
        if (input.mediaExportId && !adapters[provider]?.imagePublishingAvailable) throw new AppError(409, "Image publishing is not enabled for this destination.");
        // Each media type needs a verified export and a corresponding platform transport.
        if (provider === "Instagram" && !input.mediaExportId || item.format !== "static")
          throw new AppError(
            409,
            "This placement requires a verified media export. Copy-only publishing is available for Facebook and LinkedIn."
          );
        const scheduledFor = new Date(input.scheduledFor);
        if (
          scheduledFor.getTime() < Date.now() + 60000 ||
          scheduledFor.getTime() > Date.now() + 366 * 86400000
        )
          throw new AppError(
            400,
            "Choose a time one minute to one year ahead."
          );
        try {
          new Intl.DateTimeFormat("en", { timeZone: input.timezone });
        } catch {
          throw new AppError(400, "Choose a valid timezone.");
        }
        const image = input.mediaExportId ? await publicationExport(tx, scope, input.mediaExportId, revision.id) : null;
        if (image && image.row.purgeAfter <= scheduledFor) throw new AppError(409, "Schedule before this image export expires or save a new approved version.");
        const payload = publicationPayload.parse({
          caption: creative.caption,
          channel: provider,
          format: item.format,
          mediaExportId: input.mediaExportId ?? null,
          ...(image ? { image: { sha256: image.row.sha256, bytes: image.row.bytes, width: image.dimensions[0], height: image.dimensions[1], altText: creative.headline } } : {}),
        });
        const hash = payloadHash(payload);
        const existing = await tx.socialPublication.findUnique({
          where: {
            revisionId_connectionId: {
              revisionId: revision.id,
              connectionId: connection.id,
            },
          },
        });
        if (existing && !["SCHEDULED", "CANCELLED"].includes(existing.status))
          throw new AppError(
            409,
            "This exact version has already been submitted. It will not be posted twice."
          );
        if (existing && existing.payloadHash !== hash)
          throw new AppError(409, "This saved publication has different content. Create and approve a new copy version instead.");
        if (
          (await tx.socialPublication.count({
            where: { businessId: scope.businessId, status: "SCHEDULED" },
          })) >= 200 &&
          !existing
        )
          throw new AppError(
            409,
            "This business has reached its scheduled-post allowance."
          );
        const data = {
          brandVersion: business.version,
          payload,
          payloadHash: hash,
          status: "SCHEDULED",
          scheduledFor,
          timezone: input.timezone,
          errorCode: null,
          reconciliationAttempts: 0,
          nextReconciliationAt: null,
        };
        await tx.socialPublication.upsert({
          where: {
            revisionId_connectionId: {
              revisionId: revision.id,
              connectionId: connection.id,
            },
          },
          create: {
            businessId: scope.businessId,
            organizationId: scope.organizationId,
            revisionId: revision.id,
            connectionId: connection.id,
            ...data,
          },
          update: data,
        });
      }
    }
    await tx.auditEvent.create({
      data: {
        ...scope,
        action: `SOCIAL_${input.action.toUpperCase()}`,
        detail:
          "Explicit user action on a business-scoped social account or exact approved publication.",
      },
    });
    return { ok: true };
  });
}
