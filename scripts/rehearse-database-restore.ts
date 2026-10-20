import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PrismaClient } from "@prisma/client";
import { resolve } from "node:path";
import { localRecoveryConfig, recoveryNames, recoveryIdentifier, recoveryUrl, assertLocalContainer, isolatedEnvironment, MAX_ARCHIVE_BYTES, archiveDigest, verifyArchive } from "./recovery/safety";
import { recoverySnapshot, assertSnapshot } from "./recovery/snapshot";
import { previewIdentityQuarantine, quarantineRestoredIdentity } from "./recovery/identity-quarantine";
import { sealSecret, openSecret } from "../src/lib/secrets";
import { reserveCreditsInTransaction, finishReservationInTransaction } from "../src/lib/billing/wallet";
import { payloadHash } from "../src/lib/social/integrity";
import { base32, decodeBase32, totp, verifyTotp } from "../src/lib/identity/totp";

// This runner only makes its own synthetic databases. It cannot accept an external
// backup, overwrite an existing DB, start an app/worker, or enable paid execution.
let phase = "configuration";
function check(ok: unknown, message: string): asserts ok { if (!ok) throw Error(message); }
async function mustReject(action: () => unknown | Promise<unknown>) {
  let rejected = false; try { await action(); } catch { rejected = true; }
  check(rejected, "An expected recovery guard did not reject.");
}
function run(binary: string, args: string[], env: NodeJS.ProcessEnv, input?: Buffer, maxBytes = 1024 * 1024) {
  return new Promise<Buffer>((resolveOutput, reject) => {
    const child = spawn(binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let bytes = 0, failed = false;
    const fail = () => { if (!failed) { failed = true; child.kill("SIGKILL"); reject(Error("Bounded recovery subprocess failed.")); } };
    const timeout = setTimeout(fail, 60000);
    child.on("error", fail);
    child.stdout.on("data", (b: Buffer) => { bytes += b.length; if (bytes > maxBytes) fail(); else chunks.push(b); });
    // Drain stderr without printing potential connection strings or row data.
    child.stderr.on("data", (b: Buffer) => { bytes += b.length; if (bytes > maxBytes) fail(); });
    child.stdin.on("error", fail);
    child.on("close", code => { clearTimeout(timeout); if (failed) return; if (code !== 0) reject(Error("Recovery subprocess returned a failure.")); else resolveOutput(Buffer.concat(chunks)); });
    child.stdin.end(input);
  });
}
async function main() {
  const config = localRecoveryConfig(process.env.REHEARSAL_DATABASE_URL, process.env.REHEARSAL_DOCKER_CONTAINER);
  const env = isolatedEnvironment(), names = recoveryNames();
  phase = "local Docker verification";
  const endpoint = (await run("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], env)).toString();
  const ports = JSON.parse((await run("docker", ["inspect", "--format", '{{json (index .NetworkSettings.Ports "5432/tcp")}}', config.container], env)).toString());
  assertLocalContainer(endpoint, ports, config.url.port);
  const admin = new PrismaClient({ datasourceUrl: config.url.toString(), log: [] });
  const source = new PrismaClient({ datasourceUrl: recoveryUrl(config.url, names.source), log: [] });
  const target = new PrismaClient({ datasourceUrl: recoveryUrl(config.url, names.target), log: [] });
  const created = new Set<string>(), started = Date.now(), oldKeys = process.env.SECRET_ENCRYPTION_KEYS_JSON, oldActive = process.env.SECRET_ENCRYPTION_ACTIVE_KEY;
  const key = randomBytes(32).toString("base64"), nextKey = randomBytes(32).toString("base64");
  const pgEnv = isolatedEnvironment({ PGPASSWORD: decodeURIComponent(config.url.password) });
  const pg = (tool: string, database: string, args: string[], input?: Buffer, maxBytes?: number) => {
    recoveryIdentifier(database);
    return run("docker", ["exec", "-i", "-e", "PGPASSWORD", config.container, tool, "--host=127.0.0.1", "--port=5432", `--username=${decodeURIComponent(config.url.username)}`, `--dbname=${database}`, ...args], pgEnv, input, maxBytes);
  };
  let report: Record<string, unknown> | undefined;
  try {
    phase = "fresh database creation";
    for (const name of [names.source, names.target]) {
      // No IF NOT EXISTS: collision must stop rather than reuse anybody's data.
      await admin.$executeRawUnsafe(`CREATE DATABASE ${recoveryIdentifier(name)}`); created.add(name);
    }
    phase = "migration replay";
    await run(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], isolatedEnvironment({ DATABASE_URL: recoveryUrl(config.url, names.source) }));
    process.env.SECRET_ENCRYPTION_KEYS_JSON = JSON.stringify({ rehearsal: key }); process.env.SECRET_ENCRYPTION_ACTIVE_KEY = "rehearsal";
    phase = "synthetic fixture creation";
    const user = await source.user.create({ data: { email: `restore-${randomUUID()}@example.test`, name: "Restore fixture", passwordHash: "not-a-login-credential", emailVerifiedAt: new Date() } });
    const a = await source.organization.create({ data: { name: "Synthetic tenant A", memberships: { create: { userId: user.id, role: "OWNER" } }, wallet: { create: { available: 1000, revisionAvailable: 100 } } } });
    const b = await source.organization.create({ data: { name: "Synthetic tenant B", wallet: { create: { available: 17 } } } });
    const business = await source.business.create({ data: { organizationId: a.id, name: "Restore business", version: 3, confirmedAt: new Date(), offering: "Synthetic restoration fixture" } });
    await source.business.create({ data: { organizationId: b.id, name: "Other tenant" } });
    const setupDraft = await source.business.create({ data: { organizationId: a.id, name: "Unfinished setup", setupKey: "synthetic-setup-key", setupStep: 2, setupRevision: 3, contentPreferences: { strategy: "education", language: "English (UK)" } } });
    phase = "credit fixtures";
    await source.creditEntry.create({ data: { organizationId: a.id, key: "restore-initial-grant", kind: "GRANT", amount: 1000 } });
    const settled = await source.$transaction(tx => reserveCreditsInTransaction(tx, a.id, "already-settled", 100));
    await source.$transaction(tx => finishReservationInTransaction(tx, a.id, settled.id, 60));
    const held = await source.$transaction(tx => reserveCreditsInTransaction(tx, a.id, "uncertain-copy", 40));
    await source.$transaction(tx => reserveCreditsInTransaction(tx, a.id, "revision-hold", 20, true));
    const videoHold = await source.$transaction(tx => reserveCreditsInTransaction(tx, a.id, "synthetic-provisional-video", 7));
    await source.$transaction(tx => finishReservationInTransaction(tx, a.id, videoHold.id, 0));
    await source.wallet.update({ where: { organizationId: a.id }, data: { debt: 5, revisionDebt: 2 } });
    await source.job.create({ data: { organizationId: a.id, businessId: business.id, key: "restore-uncertain-job", kind: "COPY", status: "NEEDS_RECONCILIATION", submittedAt: new Date(), payload: { fixture: true }, reservationId: held.id, providerTaskId: "synthetic-provider-task" } });
    phase = "billing fixtures";
    const payment = await source.billingPayment.create({ data: { id: "synthetic-payment", organizationId: a.id, subscriptionId: "synthetic-subscription", periodStart: new Date("2026-01-01T00:00:00Z"), amountMinor: 80000, currency: "USD", generalCredits: 1000, revisionCredits: 100 } });
    await source.billingEvent.create({ data: { id: "synthetic-event", payload: { fixture: true }, digest: "fixture-only", status: "PROCESSED" } });
    await source.billingRefundOperation.create({ data: { id: "synthetic-refund", paymentId: payment.id, organizationId: a.id, amountMinor: 1000, operatorId: "rehearsal", evidence: "synthetic receipt", status: "NEEDS_RECONCILIATION" } });
    phase = "encrypted connection fixtures";
    const connectionId = randomUUID(), context = `social:${a.id}:${business.id}:${connectionId}`, plaintext = "synthetic-not-a-provider-token";
    await source.socialConnection.create({ data: { id: connectionId, organizationId: a.id, businessId: business.id, provider: "Instagram", status: "DISCONNECTED", externalAccountId: "synthetic", label: "Synthetic disconnected fixture", encryptedToken: sealSecret(plaintext, context), permissions: [], dataSnapshot: { fixture: "saved-account-data", followers: null }, dataFetchedAt: new Date(), dataAttemptedAt: new Date() } });
    const publicationConnection = await source.socialConnection.create({ data: { organizationId: a.id, businessId: business.id, provider: "LinkedIn", status: "DISCONNECTED", authorizationVersion: 2, externalAccountId: "urn:li:organization:123", label: "Synthetic publishing fixture", encryptedToken: "", permissions: [] } });
    await source.socialConnection.create({ data: { id: "synthetic-expired-access", organizationId: a.id, businessId: business.id, provider: "LinkedIn", status: "RECONNECT_REQUIRED", authorizationVersion: 2, externalAccountId: "urn:li:organization:124", label: "Synthetic expired access", encryptedToken: "", permissions: [], expiresAt: null } });
    const publicationPlan = await source.productionPlan.create({ data: { organizationId: a.id, businessId: business.id, brandVersion: 3, title: "Synthetic journal recovery", creditCeiling: 0, items: { create: { title: "Synthetic post", channel: "LinkedIn", format: "static", brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: { caption: "Synthetic restoration fixture." } } } } } }, include: { items: { include: { revisions: true } } } });
    const frozenPayload = { caption: "Synthetic restoration fixture.", channel: "LinkedIn", format: "static", mediaExportId: null };
    await source.weeklyPolicy.create({ data: { businessId: business.id, organizationId: a.id, actorId: user.id, brandVersion: 3, enabled: true, mode: "DRAFTS", imagesAfterApproval: true, maxItems: 1, creditsPerWeek: 100, weekday: 1, hourUTC: 9, version: 1, nextRunAt: new Date("2099-01-01T00:00:00Z") } });
    await source.weeklyCycle.create({ data: { id: "synthetic-weekly-images", businessId: business.id, organizationId: a.id, periodKey: "2026-10-12", policyVersion: 1, brandVersion: 3, planId: publicationPlan.id, status: "COMPLETE", mediaStatus: "OPEN", mediaLeaseUntil: new Date("2026-10-18T12:00:00Z"), nextMediaAt: new Date("2026-10-18T12:03:00Z"), creditsAuthorized: 40, tasks: { create: { id: "synthetic-weekly-image-task", itemId: publicationPlan.items[0].id, status: "AUTHORIZED", imageStatus: "WAITING" } } } });
    await source.socialPublication.create({ data: { id: "synthetic-publication", organizationId: a.id, businessId: business.id, connectionId: publicationConnection.id, revisionId: publicationPlan.items[0].revisions[0].id, brandVersion: 3, payload: frozenPayload, payloadHash: payloadHash(frozenPayload), scheduledFor: new Date(), timezone: "UTC", status: "NEEDS_RECONCILIATION", submissionAdapterVersion: "synthetic:publish-v1", candidatePostId: "urn:li:share:456" } });
    await source.socialPublication.update({ where: { id: "synthetic-publication" }, data: { errorCode: "ACCOUNT_DISCONNECTED" } });
    const imagePayload = { ...frozenPayload, mediaExportId: "synthetic-export-reference", image: { sha256: "a".repeat(64), bytes: 1024, width: 1080, height: 1080, altText: "Synthetic image" } };
    await source.socialPublication.update({ where: { id: "synthetic-publication" }, data: { payload: imagePayload, payloadHash: payloadHash(imagePayload), mediaTransferVersion: "synthetic:publish-v1", mediaExternalId: "urn:li:image:SYNTHETIC", mediaUploaded: true } });
    const facebookConnection = await source.socialConnection.create({ data: { organizationId: a.id, businessId: business.id, provider: "Facebook", status: "DISCONNECTED", externalAccountId: "789", label: "Synthetic image receipt", encryptedToken: "", permissions: [] } });
    const facebookItem = await source.productionItem.create({ data: { planId: publicationPlan.id, organizationId: a.id, title: "Synthetic Facebook image", channel: "Facebook", format: "static", brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: { caption: frozenPayload.caption } } } }, include: { revisions: true } });
    const facebookPayload = { ...imagePayload, channel: "Facebook" };
    await source.socialPublication.create({ data: { id: "synthetic-facebook-image", organizationId: a.id, businessId: business.id, connectionId: facebookConnection.id, revisionId: facebookItem.revisions[0].id, brandVersion: 3, payload: facebookPayload, payloadHash: payloadHash(facebookPayload), scheduledFor: new Date(), timezone: "UTC", status: "NEEDS_RECONCILIATION", mediaTransferVersion: "synthetic:image-v1", mediaExternalId: "456789", mediaUploaded: true, submissionAdapterVersion: "synthetic:image-v1", candidatePostId: "789_123" } });
    const instagramConnection = await source.socialConnection.create({ data: { organizationId: a.id, businessId: business.id, provider: "Instagram", status: "DISCONNECTED", externalAccountId: "987", label: "Synthetic container receipt", encryptedToken: "", permissions: [] } });
    const instagramItem = await source.productionItem.create({ data: { planId: publicationPlan.id, organizationId: a.id, title: "Synthetic Instagram image", channel: "Instagram", format: "static", brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: { caption: frozenPayload.caption } } } }, include: { revisions: true } });
    const instagramPayload = { ...imagePayload, channel: "Instagram" };
    await source.socialPublication.create({ data: { id: "synthetic-instagram-image", organizationId: a.id, businessId: business.id, connectionId: instagramConnection.id, revisionId: instagramItem.revisions[0].id, brandVersion: 3, payload: instagramPayload, payloadHash: payloadHash(instagramPayload), scheduledFor: new Date(), timezone: "UTC", status: "NEEDS_RECONCILIATION", mediaTransferVersion: "synthetic:ig-image-v1", mediaExternalId: "7654321", mediaUploaded: true, submissionAdapterVersion: "synthetic:ig-image-v1", candidatePostId: "1234567", mediaDeliveryTokenHash: "a".repeat(64), mediaDeliveryExpiresAt: new Date("2026-10-18T12:15:00Z"), mediaDeliverySha256: "b".repeat(64), mediaDeliveryBytes: 1234, mediaDeliveryVersion: "synthetic-jpeg-v1", mediaDeliveryAuthorizationVersion: 1, mediaDeliveryReads: 2 } });
    const invalidatedRevision = await source.creativeRevision.create({ data: { itemId: publicationPlan.items[0].id, organizationId: a.id, version: 2, status: "APPROVED", content: { caption: frozenPayload.caption } } });
    const reelItem = await source.productionItem.create({ data: { planId: publicationPlan.id, organizationId: a.id, title: "Synthetic Instagram Reel", channel: "Instagram", format: "video", brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: { caption: frozenPayload.caption } } } }, include: { revisions: true } });
    const reelPayload = { caption: frozenPayload.caption, channel: "Instagram", format: "video", mediaExportId: "synthetic-render-reference", video: { sha256: "b".repeat(64), bytes: 5242880, width: 720, height: 1280, durationMs: 5000, shareToFeed: false } };
    const linkedInVideoItem = await source.productionItem.create({ data: { planId: publicationPlan.id, organizationId: a.id, title: "Synthetic LinkedIn video", channel: "LinkedIn", format: "video", brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: { caption: frozenPayload.caption } } } }, include: { revisions: true } });
    const linkedInVideoPayload = { ...reelPayload, channel: "LinkedIn", video: { ...reelPayload.video, width: 1280, height: 720 } };
    await source.socialPublication.create({ data: { id: "synthetic-linkedin-video", organizationId: a.id, businessId: business.id, connectionId: publicationConnection.id, revisionId: linkedInVideoItem.revisions[0].id, brandVersion: 3, payload: linkedInVideoPayload, payloadHash: payloadHash(linkedInVideoPayload), scheduledFor: new Date(), timezone: "UTC", status: "NEEDS_RECONCILIATION", mediaTransferVersion: "synthetic:publish-v1:video-v1", mediaExternalId: "urn:li:video:SYNTHETIC", mediaUploaded: true, submissionAdapterVersion: "synthetic:publish-v1:video-v1", candidatePostId: "urn:li:share:457" } });
    const facebookReelItem = await source.productionItem.create({ data: { planId: publicationPlan.id, organizationId: a.id, title: "Synthetic Facebook Reel", channel: "Facebook", format: "static", brief: {}, revisions: { create: { version: 1, status: "APPROVED", content: { caption: frozenPayload.caption } } } }, include: { revisions: true } });
    const facebookReelPayload = { ...reelPayload, channel: "Facebook" };
    await source.socialPublication.create({ data: { id: "synthetic-facebook-reel", organizationId: a.id, businessId: business.id, connectionId: facebookConnection.id, revisionId: facebookReelItem.revisions[0].id, brandVersion: 3, payload: facebookReelPayload, payloadHash: payloadHash(facebookReelPayload), scheduledFor: new Date(), timezone: "UTC", status: "NEEDS_RECONCILIATION", mediaTransferVersion: "synthetic:fb:reel-v1", mediaExternalId: "456790", mediaUploaded: true, submissionAdapterVersion: "synthetic:fb:reel-v1", candidatePostId: null, errorCode: "PROVIDER_OUTCOME_UNKNOWN" } });
    await source.socialPublication.create({ data: { id: "synthetic-instagram-reel", organizationId: a.id, businessId: business.id, connectionId: instagramConnection.id, revisionId: reelItem.revisions[0].id, brandVersion: 3, payload: reelPayload, payloadHash: payloadHash(reelPayload), scheduledFor: new Date(), timezone: "UTC", status: "NEEDS_RECONCILIATION", mediaTransferVersion: "synthetic:reel-v1", mediaExternalId: "7654322", mediaUploaded: true, mediaDeliveryTokenHash: "c".repeat(64), mediaDeliveryExpiresAt: new Date("2026-10-18T12:15:00Z"), mediaDeliverySha256: "b".repeat(64), mediaDeliveryBytes: 5242880, mediaDeliveryVersion: "approved-reel-mp4-v1", mediaDeliveryAuthorizationVersion: 1, mediaDeliveryReads: 3, attempts: 15, errorCode: "MEDIA_PROCESSING_REVIEW_REQUIRED" } });
    const instagramMetricRevision = await source.creativeRevision.create({ data: { itemId: instagramItem.id, organizationId: a.id, version: 2, status: "APPROVED", content: { caption: frozenPayload.caption } } });
    const reelMetricRevision = await source.creativeRevision.create({ data: { itemId: reelItem.id, organizationId: a.id, version: 2, status: "APPROVED", content: { caption: frozenPayload.caption } } });
    await source.socialPublication.create({ data: { id: "synthetic-reel-metrics", organizationId: a.id, businessId: business.id, connectionId: instagramConnection.id, revisionId: reelMetricRevision.id, brandVersion: 3, payload: reelPayload, payloadHash: payloadHash(reelPayload), scheduledFor: new Date(), timezone: "UTC", status: "PUBLISHED", publishedAt: new Date(), externalPostId: "1234569", metrics: { create: { observedAt: new Date(), definitionVersion: "instagram-reel-views-reach-total-interactions-v26.0-v1", views: 2345, reach: 0, impressions: null, videoViews: null, engagements: null } } } });
    const facebookMetricRevision = await source.creativeRevision.create({ data: { itemId: facebookItem.id, organizationId: a.id, version: 2, status: "APPROVED", content: { caption: frozenPayload.caption } } });
    await source.socialPublication.create({ data: { id: "synthetic-facebook-metrics", organizationId: a.id, businessId: business.id, connectionId: facebookConnection.id, revisionId: facebookMetricRevision.id, brandVersion: 3, payload: facebookPayload, payloadHash: payloadHash(facebookPayload), scheduledFor: new Date(), timezone: "UTC", status: "PUBLISHED", publishedAt: new Date(), externalPostId: "789_124", metrics: { create: { observedAt: new Date(), definitionVersion: "facebook-post-views-unique-clicks-reactions-v26.0-v1", views: 1200, uniqueViewers: 800, reactions: 0, clicks: null, reach: null, impressions: null, engagements: null } } } });
    await source.socialPublication.create({ data: { id: "synthetic-instagram-metrics", organizationId: a.id, businessId: business.id, connectionId: instagramConnection.id, revisionId: instagramMetricRevision.id, brandVersion: 3, payload: instagramPayload, payloadHash: payloadHash(instagramPayload), scheduledFor: new Date(), timezone: "UTC", status: "PUBLISHED", publishedAt: new Date(), externalPostId: "1234568", metrics: { create: { observedAt: new Date(), definitionVersion: "instagram-feed-views-reach-total-interactions-v26.0-v1", views: 1234, reach: 0, impressions: null, engagements: null } } } });
    await source.socialPublication.create({ data: { id: "synthetic-invalidated-metrics", organizationId: a.id, businessId: business.id, connectionId: publicationConnection.id, revisionId: invalidatedRevision.id, brandVersion: 3, payload: frozenPayload, payloadHash: payloadHash(frozenPayload), scheduledFor: new Date(), timezone: "UTC", status: "PUBLISHED", publishedAt: new Date(), externalPostId: "urn:li:share:789", metricsInvalidatedAt: new Date(), errorCode: "METRICS_SOURCE_CHANGED", metrics: { create: { observedAt: new Date(), definitionVersion: "fixture-v2", impressions: 100 } } } });
    await source.socialPublication.update({ where: { id: "synthetic-invalidated-metrics" }, data: { metricsRequestedAt: new Date("2026-10-01T00:00:00Z") } });
    phase = "brand and identity fixtures";
    await source.knowledgeSource.create({ data: { businessId: business.id, organizationId: a.id, kind: "TEXT", title: "Fixture evidence", body: "Only synthetic facts.", sha256: archiveDigest(Buffer.from("Only synthetic facts.")), status: "APPROVED", createdBy: user.id } });
    await source.brandAsset.create({ data: { organizationId: a.id, businessId: business.id, objectKey: "synthetic/not-an-object", label: "Metadata only, no bucket object", purpose: "logo", sha256: "a".repeat(64), bytes: 3, width: 1, height: 1, uploadedBy: user.id, rightsConfirmedAt: new Date(), status: "APPROVED", approvedForGeneration: true } });
    await source.session.create({ data: { id: "synthetic-session-hash", userId: user.id, expiresAt: new Date(Date.now() + 60000) } });
    await source.socialOAuthFlow.create({ data: { id: "synthetic-meta-flow", organizationId: a.id, businessId: business.id, actorId: user.id, sessionId: "synthetic-session-hash", provider: "Facebook", authentication: "META_CONFIDENTIAL", stateHash: "synthetic-meta-state", configurationHash: "synthetic-config", expiresAt: new Date(Date.now() + 60000) } });
    await source.emailOutbox.create({ data: { id: "synthetic-email", userId: user.id, kind: "VERIFY_EMAIL", encryptedPayload: sealSecret("synthetic message", `email:synthetic-email:${user.id}`), expiresAt: new Date(Date.now() + 60000) } });
    const secondUser = await source.user.create({ data: { email: `restore-second-${randomUUID()}@example.test`, name: "Second restore fixture", passwordHash: "not-a-login-credential", authVersion: 7, memberships: { create: { organizationId: b.id, role: "VIEWER" } } } });
    await source.session.create({ data: { id: "synthetic-second-session", userId: secondUser.id, authVersion: 7, expiresAt: new Date(Date.now() + 60000) } });
    await source.identityToken.createMany({ data: [
      { id: "synthetic-reset", userId: user.id, kind: "RESET_PASSWORD", expiresAt: new Date(Date.now() + 60000) },
      { id: "synthetic-verify", userId: secondUser.id, kind: "VERIFY_EMAIL", expiresAt: new Date(Date.now() + 60000) },
      { id: "synthetic-used", userId: user.id, kind: "VERIFY_EMAIL", usedAt: new Date("2026-01-01Z"), expiresAt: new Date("2026-01-02Z") },
    ] });
    await source.teamInvitation.createMany({ data: ["PENDING", "ACCEPTED", "REVOKED"].map(status => ({ id: `synthetic-invite-${status}`, organizationId: a.id, email: "invited@example.test", role: "VIEWER", createdBy: user.id, outboxId: `synthetic-invite-mail-${status}`, status, expiresAt: new Date(Date.now() + 60000) })) });
    await source.emailOutbox.createMany({ data: ["SENDING", "ACCEPTED", "FAILED"].map(status => ({ id: `synthetic-mail-${status}`, userId: secondUser.id, kind: "RESET_PASSWORD", encryptedPayload: status === "SENDING" ? "synthetic-encrypted-payload" : "", status, attempts: 2, leaseUntil: status === "SENDING" ? new Date(Date.now() + 60000) : null, providerId: status === "ACCEPTED" ? "synthetic-provider-receipt" : null, expiresAt: new Date(Date.now() + 60000) })) });
    const fixtureFactor = base32(Buffer.alloc(20, 7));
    await source.mfaCredential.create({ data: { userId: user.id, encryptedSecret: sealSecret(fixtureFactor, `mfa:${user.id}`), enabledAt: new Date(), recoveryHashes: ["synthetic-recovery-hash"], lastStep: 1 } });
    await source.mfaCredential.create({ data: { userId: secondUser.id, pendingSecret: "synthetic-pending-enrollment", pendingExpiresAt: new Date(Date.now() + 60000) } });
    phase = "provisional video accounting fixture";
    await source.supplierAuthorization.create({ data: { key: "synthetic-provisional-video", ceilingMicros: 70000 } });
    await source.videoGeneration.create({ data: {
      id: "synthetic-provisional-video", businessId: business.id, organizationId: a.id, actorId: user.id,
      knowledgeContext: { version: 1, fixture: "Restore exact authorized knowledge, not a live model request" },
      storyboardId: "synthetic-board", itemId: "synthetic-item", brandVersion: 3, shotId: "synthetic-shot", shotLabel: "Restore fixture",
      documentHash: "synthetic-hash", prompt: "Synthetic fixture; never submitted", route: { expensePolicy: "account-quote-v1" }, configurationHash: "synthetic-config",
      durationMs: 5000, status: "FAILED", credits: 7, supplierCeilingMicros: 70000, supplierEstimateMicros: 60000, expenseBasis: "ACCOUNT_QUOTE_V1",
      reservationId: videoHold.id, settledAt: new Date(), expiresAt: new Date(), errorCode: "NORMALIZATION_FAILED",
      receipt: { submission: { journal: "synthetic-private-journal" }, estimatedCostMicros: 60000, expenseBasis: "ACCOUNT_QUOTE_V1" },
    } });
    phase = "instrumental audio fixture";
    await source.weeklyPolicy.update({ where: { businessId: business.id }, data: { maxItems: 2, videoItems: 1, videosAfterApproval: true } });
    await source.productionItem.update({ where: { id: facebookItem.id }, data: { revisionRequests: 3 } });
    await source.weeklyCycle.create({ data: { id: "synthetic-weekly-video", businessId: business.id, organizationId: a.id,
      periodKey: "2026-10-19", policyVersion: 1, brandVersion: 3, planId: publicationPlan.id, status: "COMPLETE", videoStatus: "OPEN",
      videoLeaseUntil: new Date("2026-10-19T12:00:00Z"), nextVideoAt: new Date("2026-10-19T12:03:00Z"), creditsAuthorized: 47,
      tasks: { create: { id: "synthetic-weekly-video-task", itemId: "synthetic-item", status: "AUTHORIZED", videoStatus: "PRODUCING", storyboardId: "synthetic-board",
        shots: { create: { shotId: "synthetic-shot", generationId: "synthetic-provisional-video" } } } } } });
    await source.videoGeneration.create({ data: {
      id: "synthetic-new-take", businessId: business.id, organizationId: a.id, actorId: user.id,
      storyboardId: "synthetic-board", itemId: "synthetic-item", brandVersion: 3, shotId: "synthetic-shot", shotLabel: "Direction history fixture",
      documentHash: "synthetic-hash", prompt: "Synthetic new take; never submitted", route: {}, configurationHash: "synthetic-config",
      durationMs: 5000, credits: 7, supplierCeilingMicros: 70000, expiresAt: new Date(),
      revisionOfId: "synthetic-provisional-video", creativeBrief: { version: 1, direction: "Warm side lighting.", revisions: [{ parentId: "synthetic-provisional-video", feedback: "Slower camera movement." }] },
    } });
    await source.videoClip.create({ data: { id: "synthetic-audio", businessId: business.id, organizationId: a.id, brandVersion: 3, label: "Synthetic audio metadata only", mediaKind: "AUDIO", instrumentalConfirmedAt: new Date(), createdBy: user.id, rightsConfirmedAt: new Date(), status: "READY", sourceKey: "synthetic/audio-source.wav", sourceHash: "a".repeat(64), sourceBytes: 1024, objectKey: "synthetic/audio-normalized.wav", sha256: "b".repeat(64), bytes: 2048, durationMs: 3000, processorVersion: "instrumental-pcm-v1", purgeAfter: new Date(Date.now() + 86400000) } });
    const learnedMemory = await source.memory.create({ data: { businessId: business.id, organizationId: a.id, kind: "APPROVED_SKILL", text: "Synthetic learned-skill restore fixture, not eligible runtime evidence." } });
    await source.learningProposal.create({ data: { id: "synthetic-learned-skill", businessId: business.id, organizationId: a.id, brandVersion: 3, status: "SKILL_ACTIVE", memoryId: learnedMemory.id, hypothesis: learnedMemory.text, evidence: { kind: "FEEDBACK_SKILL_V1", fixture: true } } });
    phase = "backup checkpoint";
    const before = await recoverySnapshot(source), dumpStarted = Date.now();
    const archive = await pg("pg_dump", names.source, ["--format=custom", "--no-owner", "--no-privileges"], undefined, MAX_ARCHIVE_BYTES);
    const digest = archiveDigest(archive), backupMs = Date.now() - dumpStarted;
    verifyArchive(archive, digest);
    const corrupt = Buffer.from(archive); corrupt[corrupt.length - 1] ^= 1;
    await mustReject(() => verifyArchive(corrupt, digest));
    // Prove a point-in-time snapshot, not a fresh copy of the subsequently changed source.
    await source.business.update({ where: { id: business.id }, data: { name: "Changed after the backup" } });
    await mustReject(async () => assertSnapshot(before, await recoverySnapshot(source)));
    phase = "isolated archive restore";
    const restoreStarted = Date.now();
    await pg("pg_restore", names.target, ["--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges"], archive);
    const restoreMs = Date.now() - restoreStarted;
    phase = "schema and row verification";
    assertSnapshot(before, await recoverySnapshot(target));
    const learnedSkill = await target.learningProposal.findUniqueOrThrow({ where: { id: "synthetic-learned-skill" } });
    check(learnedSkill.status === "SKILL_ACTIVE" && learnedSkill.memoryId === learnedMemory.id && (await target.memory.findUniqueOrThrow({ where: { id: learnedMemory.id } })).kind === "APPROVED_SKILL", "Learned-skill state or recall linkage lost.");
    await mustReject(() => target.learningProposal.update({ where: { id: learnedSkill.id }, data: { evidence: {} } }));
    const weekly = await target.weeklyCycle.findUniqueOrThrow({ where: { id: "synthetic-weekly-images" }, include: { tasks: true } });
    check(weekly.status === "COMPLETE" && weekly.mediaStatus === "OPEN" && weekly.creditsAuthorized === 40 && weekly.mediaLeaseUntil?.toISOString() === "2026-10-18T12:00:00.000Z" && weekly.nextMediaAt?.toISOString() === "2026-10-18T12:03:00.000Z" && weekly.tasks[0].imageStatus === "WAITING", "Weekly image authorization, budget or lease not preserved.");
    check((await target.weeklyPolicy.findUniqueOrThrow({ where: { businessId: business.id } })).imagesAfterApproval, "Weekly image consent lost.");
    const weeklyVideo = await target.weeklyCycle.findUniqueOrThrow({ where: { id: "synthetic-weekly-video" }, include: { tasks: { include: { shots: true } } } });
    check(weeklyVideo.videoStatus === "OPEN" && weeklyVideo.creditsAuthorized === 47 && weeklyVideo.videoLeaseUntil?.toISOString() === "2026-10-19T12:00:00.000Z" && weeklyVideo.nextVideoAt?.toISOString() === "2026-10-19T12:03:00.000Z" && weeklyVideo.tasks[0].shots[0].generationId === "synthetic-provisional-video", "Weekly video budget, lease or scene linkage lost.");
    const videoPolicy = await target.weeklyPolicy.findUniqueOrThrow({ where: { businessId: business.id } });
    check(videoPolicy.videoItems === 1 && videoPolicy.videosAfterApproval, "Weekly video consent lost.");
    check((await target.productionItem.findUniqueOrThrow({ where: { id: facebookItem.id } })).revisionRequests === 3, "Creative revision limit lost.");
    await mustReject(() => target.productionItem.update({ where: { id: facebookItem.id }, data: { revisionRequests: -1 } }));
    await mustReject(() => target.weeklyTask.update({ where: { id: "synthetic-weekly-video-task" }, data: { videoStatus: "RENDERED" } }));
    await mustReject(() => target.weeklyPolicy.update({ where: { businessId: business.id }, data: { videoItems: 3 } }));
    await mustReject(() => target.weeklyPolicy.update({ where: { businessId: business.id }, data: { mode: "PLAN" } }));
    await mustReject(() => target.weeklyTask.update({ where: { id: "synthetic-weekly-image-task" }, data: { imageStatus: "AUTHORIZED" } }));
    const audio = await target.videoClip.findUniqueOrThrow({ where: { id: "synthetic-audio" } });
    const restoredSetup = await target.business.findUniqueOrThrow({ where: { id: setupDraft.id } });
    check(restoredSetup.setupStep === 2 && restoredSetup.setupRevision === 3 && restoredSetup.confirmedAt === null && isDeepStrictEqual(restoredSetup.contentPreferences, { strategy: "education", language: "English (UK)" }), "Setup progress or preferences lost.");
    await mustReject(() => target.business.update({ where: { id: setupDraft.id }, data: { setupStep: null } }));
    check(audio.mediaKind === "AUDIO" && audio.instrumentalConfirmedAt !== null && audio.status === "READY" && audio.approvedBy === null && audio.durationMs === 3000, "Audio rights or review state not preserved.");
    await mustReject(() => target.videoClip.update({ where: { id: audio.id }, data: { instrumentalConfirmedAt: null } }));
    await mustReject(() => target.videoClip.update({ where: { id: audio.id }, data: { durationMs: 30001 } }));
    const video = await target.videoGeneration.findUniqueOrThrow({ where: { id: "synthetic-provisional-video" } });
    check(isDeepStrictEqual(video.knowledgeContext, { version: 1, fixture: "Restore exact authorized knowledge, not a live model request" }), "Authorized knowledge snapshot not restored.");
    check(video.status === "FAILED" && video.supplierEstimateMicros === 60000 && video.expenseBasis === "ACCOUNT_QUOTE_V1" && video.supplierCostMicros === null && video.supplierReconciledAt === null, "Provisional expense was misrepresented as a final invoice.");
    await mustReject(() => target.videoGeneration.update({ where: { id: video.id }, data: { expenseBasis: null } }));
    const take = await target.videoGeneration.findUniqueOrThrow({ where: { id: "synthetic-new-take" } });
    check(take.revisionOfId === video.id && isDeepStrictEqual(take.creativeBrief, { version: 1, direction: "Warm side lighting.", revisions: [{ parentId: video.id, feedback: "Slower camera movement." }] }), "Shot direction or lineage not preserved.");
    await mustReject(() => target.videoGeneration.update({ where: { id: take.id }, data: { revisionOfId: null } }));
    await mustReject(() => target.videoGeneration.update({ where: { id: take.id }, data: { creativeBrief: {} } }));
    check((await target.socialOAuthFlow.findUniqueOrThrow({ where: { id: "synthetic-meta-flow" } })).authentication === "META_CONFIDENTIAL", "Meta authorization mode not preserved.");
    check((await target.socialConnection.findUniqueOrThrow({ where: { id: connectionId } })).dataSnapshot !== null, "Saved account data not preserved.");
    const restoredPublication = await target.socialPublication.findUniqueOrThrow({ where: { id: "synthetic-publication" } });
    const disconnected = await target.socialConnection.findUniqueOrThrow({ where: { id: publicationConnection.id } });
    const expiredAccess = await target.socialConnection.findUniqueOrThrow({ where: { id: "synthetic-expired-access" } });
    check(expiredAccess.status === "RECONNECT_REQUIRED" && expiredAccess.authorizationVersion === 2 && expiredAccess.encryptedToken === "" && expiredAccess.permissions.length === 0 && expiredAccess.expiresAt === null && expiredAccess.dataSnapshot === null, "Expired grant cleanup not preserved.");
    check(disconnected.authorizationVersion === 2 && disconnected.status === "DISCONNECTED" && disconnected.encryptedToken === "" && restoredPublication.errorCode === "ACCOUNT_DISCONNECTED" && restoredPublication.nextReconciliationAt === null, "Disconnection fence or credential removal not preserved.");
    await mustReject(() => target.socialConnection.update({ where: { id: disconnected.id }, data: { authorizationVersion: 0 } }));
    const invalidated = await target.socialPublication.findUniqueOrThrow({ where: { id: "synthetic-invalidated-metrics" }, include: { metrics: true } });
    check(invalidated.status === "PUBLISHED" && invalidated.metricsInvalidatedAt !== null && invalidated.nextMetricsAt === null && invalidated.metrics.length === 1, "Invalidated metric provenance or historical receipt lost.");
    check(invalidated.metricsRequestedAt?.toISOString() === "2026-10-01T00:00:00.000Z", "Metric recovery history not preserved.");
    const nativeMetric = await target.metricSnapshot.findFirstOrThrow({ where: { publicationId: "synthetic-instagram-metrics" } });
    check(nativeMetric.views === 1234 && nativeMetric.reach === 0 && nativeMetric.impressions === null && nativeMetric.engagements === null, "Native views, zero and unknown metrics were not preserved.");
    const reelMetric = await target.metricSnapshot.findFirstOrThrow({ where: { publicationId: "synthetic-reel-metrics" } });
    check(reelMetric.definitionVersion === "instagram-reel-views-reach-total-interactions-v26.0-v1" && reelMetric.views === 2345 && reelMetric.reach === 0 && reelMetric.impressions === null && reelMetric.videoViews === null && reelMetric.engagements === null, "Reel native definition, zero and unknown readings were not preserved.");
    await mustReject(() => target.metricSnapshot.update({ where: { id: nativeMetric.id }, data: { views: -1 } }));
    const facebookMetric = await target.metricSnapshot.findFirstOrThrow({ where: { publicationId: "synthetic-facebook-metrics" } });
    check(facebookMetric.views === 1200 && facebookMetric.uniqueViewers === 800 && facebookMetric.reactions === 0 && facebookMetric.clicks === null && facebookMetric.reach === null && facebookMetric.impressions === null, "Facebook native metric semantics were not preserved.");
    for (const data of [{ uniqueViewers: -1 }, { reactions: -1 }]) await mustReject(() => target.metricSnapshot.update({ where: { id: facebookMetric.id }, data }));
    await mustReject(() => target.socialPublication.update({ where: { id: invalidated.id }, data: { nextMetricsAt: new Date() } }));
    await mustReject(() => target.socialPublication.update({ where: { id: invalidated.id }, data: { metricsLeaseUntil: new Date() } }));
    check(restoredPublication.status === "NEEDS_RECONCILIATION" && restoredPublication.submissionAdapterVersion === "synthetic:publish-v1" && restoredPublication.candidatePostId === "urn:li:share:456" && restoredPublication.externalPostId === null, "Uncertain publication journal not preserved.");
    check(restoredPublication.mediaTransferVersion === "synthetic:publish-v1" && restoredPublication.mediaExternalId === "urn:li:image:SYNTHETIC" && restoredPublication.mediaUploaded && restoredPublication.payloadHash === payloadHash(imagePayload), "Image transfer journal or immutable image binding not preserved.");
    const facebookImage = await target.socialPublication.findUniqueOrThrow({ where: { id: "synthetic-facebook-image" } });
    check(facebookImage.status === "NEEDS_RECONCILIATION" && facebookImage.mediaTransferVersion === "synthetic:image-v1" && facebookImage.mediaExternalId === "456789" && facebookImage.mediaUploaded && facebookImage.candidatePostId === "789_123" && facebookImage.payloadHash === payloadHash(facebookPayload), "Facebook image/post journals not preserved.");
    await mustReject(() => target.socialPublication.update({ where: { id: facebookImage.id }, data: { mediaExternalId: "urn:li:image:WRONG_PROVIDER" } }));
    const instagramImage = await target.socialPublication.findUniqueOrThrow({ where: { id: "synthetic-instagram-image" } });
    const facebookReel = await target.socialPublication.findUniqueOrThrow({ where: { id: "synthetic-facebook-reel" } });
    const linkedInVideo = await target.socialPublication.findUniqueOrThrow({ where: { id: "synthetic-linkedin-video" } });
    check(linkedInVideo.status === "NEEDS_RECONCILIATION" && linkedInVideo.mediaUploaded && linkedInVideo.mediaExternalId === "urn:li:video:SYNTHETIC" && linkedInVideo.submissionAdapterVersion === "synthetic:publish-v1:video-v1" && linkedInVideo.candidatePostId === "urn:li:share:457" && linkedInVideo.payloadHash === payloadHash(linkedInVideoPayload), "LinkedIn final-video journal not preserved.");
    await mustReject(() => target.socialPublication.update({ where: { id: linkedInVideo.id }, data: { mediaExternalId: "urn:li:image:WRONG_FAMILY" } }));
    await mustReject(() => target.socialPublication.update({ where: { id: restoredPublication.id }, data: { mediaExternalId: "urn:li:video:WRONG_FAMILY" } }));
    check(facebookReel.status === "NEEDS_RECONCILIATION" && facebookReel.mediaUploaded && facebookReel.mediaExternalId === "456790" && facebookReel.submissionAdapterVersion === "synthetic:fb:reel-v1" && facebookReel.candidatePostId === null && facebookReel.mediaDeliveryTokenHash === null && facebookReel.payloadHash === payloadHash(facebookReelPayload), "Facebook asynchronous Reel journal not preserved.");
    await mustReject(() => target.socialPublication.update({ where: { id: facebookReel.id }, data: { mediaExternalId: "urn:li:video:INVALID" } }));
    await mustReject(() => target.socialPublication.update({ where: { id: facebookReel.id }, data: { mediaDeliveryTokenHash: "a".repeat(64) } }));
    const reel = await target.socialPublication.findUniqueOrThrow({ where: { id: "synthetic-instagram-reel" } });
    check(reel.status === "NEEDS_RECONCILIATION" && reel.mediaExternalId === "7654322" && reel.submissionAdapterVersion === null && reel.mediaDeliveryBytes === 5242880 && reel.mediaDeliveryReads === 3 && reel.attempts === 15 && reel.mediaDeliveryVersion === "approved-reel-mp4-v1" && reel.payloadHash === payloadHash(reelPayload), "Reel processing/delivery journal not preserved.");
    await mustReject(() => target.socialPublication.update({ where: { id: reel.id }, data: { mediaDeliveryBytes: 20971521 } }));
    await mustReject(() => target.socialPublication.update({ where: { id: reel.id }, data: { payload: { ...reelPayload, channel: "Facebook" } } }));
    await mustReject(() => target.socialPublication.update({ where: { id: instagramImage.id }, data: { mediaDeliveryBytes: 5242880 } }));
    check(instagramImage.status === "NEEDS_RECONCILIATION" && instagramImage.mediaExternalId === "7654321" && instagramImage.candidatePostId === "1234567" && instagramImage.mediaDeliveryTokenHash === "a".repeat(64) && instagramImage.mediaDeliverySha256 === "b".repeat(64) && instagramImage.mediaDeliveryBytes === 1234 && instagramImage.mediaDeliveryReads === 2 && instagramImage.mediaDeliveryAuthorizationVersion === 1 && instagramImage.mediaDeliveryExpiresAt?.toISOString() === "2026-10-18T12:15:00.000Z", "Instagram journal/delivery metadata not preserved.");
    await mustReject(() => target.socialPublication.update({ where: { id: instagramImage.id }, data: { mediaDeliveryReads: 13 } }));
    await mustReject(() => target.socialPublication.update({ where: { id: instagramImage.id }, data: { mediaDeliveryBytes: null } }));
    await mustReject(() => target.socialPublication.update({ where: { id: facebookImage.id }, data: { mediaDeliveryTokenHash: "a".repeat(64) } }));
    await mustReject(() => target.socialPublication.update({ where: { id: restoredPublication.id }, data: { mediaExternalId: "456789" } }));
    await mustReject(() => target.socialPublication.update({ where: { id: restoredPublication.id }, data: { mediaTransferVersion: null } }));
    await mustReject(() => target.socialPublication.update({ where: { id: restoredPublication.id }, data: { submissionAdapterVersion: null } }));
    check((await target.business.findUniqueOrThrow({ where: { id: business.id } })).name === "Restore business", "Backup checkpoint not preserved.");
    check(await target.business.count({ where: { id: business.id, organizationId: b.id } }) === 0, "Tenant-scoped read failed.");
    await mustReject(() => target.knowledgeSource.create({ data: { businessId: business.id, organizationId: b.id, title: "Must reject", kind: "TEXT", createdBy: user.id } }));
    await mustReject(() => target.creditEntry.create({ data: { organizationId: a.id, key: "restore-initial-grant", kind: "GRANT", amount: 1000 } }));
    await mustReject(() => target.billingPayment.create({ data: { ...payment, id: "duplicate-period" } }));
    phase = "key continuity verification";
    const encrypted = (await target.socialConnection.findUniqueOrThrow({ where: { id: connectionId } })).encryptedToken;
    process.env.SECRET_ENCRYPTION_KEYS_JSON = JSON.stringify({ rehearsal: key, rotated: nextKey }); process.env.SECRET_ENCRYPTION_ACTIVE_KEY = "rotated";
    check(openSecret(encrypted, context) === plaintext, "Retained key did not decrypt restored data.");
    await mustReject(() => openSecret(encrypted, `social:${b.id}:${business.id}:${connectionId}`));
    process.env.SECRET_ENCRYPTION_KEYS_JSON = JSON.stringify({ rotated: nextKey });
    await mustReject(() => openSecret(encrypted, context));
    process.env.SECRET_ENCRYPTION_KEYS_JSON = JSON.stringify({ rehearsal: key, rotated: nextKey });
    phase = "accounting and uncertain-state verification";
    const wallet = await target.wallet.findUniqueOrThrow({ where: { organizationId: a.id } });
    check(wallet.available === 900 && wallet.held === 60 && wallet.revisionAvailable === 80 && wallet.debt === 5 && wallet.revisionDebt === 2, "Restored wallet differs.");
    check((await target.job.findUniqueOrThrow({ where: { key: "restore-uncertain-job" } })).status === "NEEDS_RECONCILIATION", "Uncertain job was silently reset.");
    check((await target.billingRefundOperation.findUniqueOrThrow({ where: { id: "synthetic-refund" } })).status === "NEEDS_RECONCILIATION", "Uncertain refund was silently reset.");
    await target.$transaction(tx => finishReservationInTransaction(tx, a.id, settled.id, 60));
    check(JSON.stringify(await target.wallet.findUniqueOrThrow({ where: { organizationId: a.id } })) === JSON.stringify(wallet), "Restored settlement replay changed balance.");
    await mustReject(() => target.$transaction(tx => finishReservationInTransaction(tx, a.id, settled.id, 61)));
    await mustReject(() => target.$transaction(tx => finishReservationInTransaction(tx, b.id, held.id, 0)));
    // Synthetic resolution only: exercise restored ledger behavior, never run a worker.
    await target.$transaction(tx => finishReservationInTransaction(tx, a.id, held.id, 10));
    await target.$transaction(tx => finishReservationInTransaction(tx, a.id, held.id, 10));
    const resolved = await target.wallet.findUniqueOrThrow({ where: { organizationId: a.id } });
    check(resolved.available === 925 && resolved.held === 20 && resolved.debt === 0 && resolved.revisionDebt === 2, "Debt-aware settlement was not preserved.");
    check((await target.wallet.findUniqueOrThrow({ where: { organizationId: b.id } })).available === 17, "Other tenant wallet changed.");
    check(await target.emailOutbox.count({ where: { status: "QUEUED", providerId: null, attempts: 0 } }) === 1, "Email outbox changed without delivery authorization.");
    await mustReject(async () => assertSnapshot(before, await recoverySnapshot(target)));
    phase = "restored identity quarantine";
    const identityBefore = await recoverySnapshot(target), preview = await previewIdentityQuarantine(target, names.target);
    assertSnapshot(identityBefore, await recoverySnapshot(target));
    await mustReject(() => previewIdentityQuarantine(source, names.target));
    await mustReject(() => quarantineRestoredIdentity(target, names.source, preview.fingerprint));
    await mustReject(() => quarantineRestoredIdentity(target, names.target, "0".repeat(64)));
    assertSnapshot(identityBefore, await recoverySnapshot(target));
    // Same counts but changed content must invalidate the preview.
    await target.session.update({ where: { id: "synthetic-second-session" }, data: { expiresAt: new Date(Date.now() + 120000) } });
    await mustReject(() => quarantineRestoredIdentity(target, names.target, preview.fingerprint));
    // A late failure rolls back session/token/email writes as well as auth versions.
    await target.$executeRawUnsafe('ALTER TABLE "MfaCredential" ADD CONSTRAINT synthetic_quarantine_failure CHECK ("enabledAt" IS NOT NULL OR "pendingSecret" <> \'\')');
    const rollbackBefore = await recoverySnapshot(target), rollbackPreview = await previewIdentityQuarantine(target, names.target);
    await mustReject(() => quarantineRestoredIdentity(target, names.target, rollbackPreview.fingerprint));
    assertSnapshot(rollbackBefore, await recoverySnapshot(target));
    await target.$executeRawUnsafe('ALTER TABLE "MfaCredential" DROP CONSTRAINT synthetic_quarantine_failure');
    const confirmed = await previewIdentityQuarantine(target, names.target), protectedBefore = await recoverySnapshot(target), quarantineAt = new Date();
    const competingQuarantines = await Promise.allSettled([
      quarantineRestoredIdentity(target, names.target, confirmed.fingerprint, quarantineAt),
      quarantineRestoredIdentity(target, names.target, confirmed.fingerprint, quarantineAt),
    ]);
    const successfulQuarantines = competingQuarantines.filter(result => result.status === "fulfilled");
    check(successfulQuarantines.length === 1, "Concurrent quarantine was applied more than once.");
    const quarantine = successfulQuarantines[0].value;
    check(quarantine.before.fingerprint === confirmed.fingerprint && quarantine.after.fingerprint !== confirmed.fingerprint, "Quarantine receipt did not bind the inspected target.");
    check(await target.session.count() === 0 && await target.socialOAuthFlow.count() === 0, "Restored session or OAuth grant survived quarantine.");
    check(await target.identityToken.count({ where: { usedAt: null } }) === 0, "Restored identity token remains usable.");
    check((await target.identityToken.findUniqueOrThrow({ where: { id: "synthetic-used" } })).usedAt?.toISOString() === "2026-01-01T00:00:00.000Z", "Used-token evidence changed.");
    check(await target.teamInvitation.count({ where: { status: "PENDING" } }) === 0 && await target.teamInvitation.count({ where: { status: "ACCEPTED" } }) === 1, "Invitation quarantine lost accepted history.");
    check(await target.emailOutbox.count({ where: { status: { in: ["QUEUED", "SENDING"] } } }) === 0, "Restored mail can still be retried.");
    const quarantinedMail = await target.emailOutbox.findUniqueOrThrow({ where: { id: "synthetic-mail-SENDING" } });
    check(quarantinedMail.status === "EXPIRED" && quarantinedMail.encryptedPayload === "" && quarantinedMail.leaseUntil === null && quarantinedMail.attempts === 2 && quarantinedMail.providerId === null, "Uncertain mail history or secret cleanup failed.");
    check((await target.emailOutbox.findUniqueOrThrow({ where: { id: "synthetic-mail-ACCEPTED" } })).providerId === "synthetic-provider-receipt", "Accepted mail receipt lost.");
    const factor = await target.mfaCredential.findUniqueOrThrow({ where: { userId: user.id } });
    check(factor.enabledAt !== null && openSecret(factor.encryptedSecret, `mfa:${user.id}`) === fixtureFactor && factor.recoveryHashes.length === 0 && factor.lastStep === Math.floor(quarantineAt.getTime() / 30000) + 1, "Enrolled MFA or replay fence lost.");
    for (const offset of [-30000, 0, 30000]) check(verifyTotp(fixtureFactor, totp(decodeBase32(fixtureFactor), quarantineAt.getTime() + offset), factor.lastStep, quarantineAt) === null, "Restored TOTP replay window remains usable.");
    const later = new Date(quarantineAt.getTime() + 90000);
    check(verifyTotp(fixtureFactor, totp(decodeBase32(fixtureFactor), later.getTime()), factor.lastStep, later) !== null, "Retained authenticator cannot resume after the replay fence.");
    check((await target.mfaCredential.findUniqueOrThrow({ where: { userId: secondUser.id } })).pendingSecret === "", "Pending MFA enrollment survived.");
    check((await target.user.findUniqueOrThrow({ where: { id: user.id } })).authVersion === 1 && (await target.user.findUniqueOrThrow({ where: { id: secondUser.id } })).authVersion === 8, "Not all restored login versions were invalidated.");
    for (const id of [user.id, secondUser.id]) {
      const original = await source.user.findUniqueOrThrow({ where: { id } }), restored = await target.user.findUniqueOrThrow({ where: { id } });
      check(isDeepStrictEqual({ ...restored, authVersion: original.authVersion }, original), "Quarantine modified retained user identity or password.");
    }
    const protectedAfter = await recoverySnapshot(target), identityTables = new Set(["User", "Session", "IdentityToken", "TeamInvitation", "EmailOutbox", "MfaCredential", "SocialOAuthFlow"]);
    assertSnapshot({ ...protectedBefore, tables: protectedBefore.tables.filter(t => !identityTables.has(t.name)) }, { ...protectedAfter, tables: protectedAfter.tables.filter(t => !identityTables.has(t.name)) });
    await mustReject(() => quarantineRestoredIdentity(target, names.target, confirmed.fingerprint));
    assertSnapshot(protectedAfter, await recoverySnapshot(target));
    check(await source.session.count() === 2 && await source.identityToken.count({ where: { usedAt: null } }) === 2, "Source was modified by target quarantine.");
    report = { status: "passed", scope: "synthetic-local-database-only", archiveBytes: archive.length, archiveSha256: digest,
      tablesVerified: before.tables.length, rowsVerified: before.tables.reduce((n, t) => n + t.count, 0),
      migrationsVerified: before.tables.find(t => t.name === "_prisma_migrations")?.count,
      schemaHash: before.schemaHash, backupMs, restoreMs, elapsedMs: Date.now() - started,
      checks: ["schema-and-all-row-fingerprints", "post-backup-change-excluded", "corrupt-archive-rejected", "tenant-foreign-keys", "ledger-and-payment-uniqueness", "settlement-replay", "refund-debt", "uncertain-job-and-refund-preservation", "uncertain-publication-journal-and-constraint", "retained-key-decryption", "missing-key-and-cross-tenant-decryption-denial", "unchanged-email-outbox"],
      identityQuarantineVerified: true, identityQuarantineCounts: quarantine.before.counts,
      identityQuarantineChecks: ["preview-read-only", "exact-target", "changed-content-denial", "late-failure-rollback", "single-concurrent-application", "sessions-and-oauth-cleared", "one-use-links-invalidated", "queued-email-quarantined", "mfa-retained-and-replay-fenced", "unrelated-table-fingerprints-unchanged", "source-unchanged", "stale-replay-denied"],
      metricProvenanceVerified: true, provisionalVideoExpenseVerified: true, productionRecoveryVerified: false, objectStorageVerified: false, workersStarted: 0, providerCalls: 0 };
  } finally {
    if (oldKeys === undefined) delete process.env.SECRET_ENCRYPTION_KEYS_JSON; else process.env.SECRET_ENCRYPTION_KEYS_JSON = oldKeys;
    if (oldActive === undefined) delete process.env.SECRET_ENCRYPTION_ACTIVE_KEY; else process.env.SECRET_ENCRYPTION_ACTIVE_KEY = oldActive;
    await Promise.all([source.$disconnect(), target.$disconnect()]);
    const cleanupFailures: string[] = [];
    for (const name of created) {
      try { await admin.$executeRawUnsafe(`DROP DATABASE ${recoveryIdentifier(name)}`); }
      catch { cleanupFailures.push(name); }
    }
    await admin.$disconnect();
    if (cleanupFailures.length) { console.error(`Disposable rehearsal databases need manual cleanup: ${cleanupFailures.join(", ")}`); throw Error("Rehearsal cleanup incomplete."); }
  }
  console.info(JSON.stringify({ ...report, temporaryDatabasesRemoved: created.size }, null, 2));
}
void main().catch(() => { console.error(`Restore rehearsal failed during ${phase}. No app or worker was started. Connection details and row data are not printed.`); process.exitCode = 1; });
