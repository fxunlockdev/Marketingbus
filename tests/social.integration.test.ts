import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/db";
import {
  manageSocial,
  saveVerifiedConnection,
} from "../src/lib/social/service";
import {
  runOnePublication,
  recoverSocialLeases,
  reconcilePublication,
  runOneMetricSync,
  runOneReconciliation,
  MAX_RECONCILIATION_ATTEMPTS,
} from "../src/lib/social/worker";
import { actOnProduction } from "../src/lib/production/service";
import {
  readSocialDashboard,
  manageLearning,
} from "../src/lib/social/analytics";
import type { SocialAdapter } from "../src/lib/social/contracts";
import { payloadHash } from "../src/lib/social/integrity";
import { resumePublicationLookup } from "../src/lib/social/recovery";
import { seedLearningEvidence } from "./fixtures/learning";
import { productionMemories, validLearningEvidence } from "../src/lib/social/learning-evidence";
import { publishingFixture } from "./helpers/linkedin-publishing";
import { submissionJournal } from "../src/lib/social/submission-journal";
import { LINKEDIN_SCOPES } from "../src/lib/social/linkedin-oauth";
import { facebookPublishingFixture } from "./helpers/facebook-publishing";
import { META_SCOPES } from "../src/lib/social/meta-oauth";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (
  process.env.TEST_DATABASE_URL &&
  (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL ||
    !["localhost", "127.0.0.1"].includes(
      new URL(process.env.TEST_DATABASE_URL).hostname
    ))
)
  throw Error("Local test DB required");
const creative = {
  headline: "Made for your home",
  caption: "Considered architecture for your home.",
  cta: "Meet the studio",
  visualDirection: "Use approved brand typography",
  rationale: "A clear service introduction",
  evidenceUsed: [],
};
suite("social publishing and analytics isolation", () => {
  const orgs: string[] = [];
  const users: string[] = [];
  afterEach(async () => { await db.socialPublication.deleteMany({ where: { organizationId: { in: orgs } } }); });
  beforeAll(() => {
    vi.stubEnv(
      "SECRET_ENCRYPTION_KEYS_JSON",
      JSON.stringify({ test: randomBytes(32).toString("base64") })
    );
    vi.stubEnv("SECRET_ENCRYPTION_ACTIVE_KEY", "test");
  });
  afterAll(async () => {
    await db.socialPublication.deleteMany({
      where: { organizationId: { in: orgs } },
    });
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    vi.unstubAllEnvs();
    await db.$disconnect();
  });
  async function setup() {
    const org = await db.organization.create({
      data: { name: "SOCIAL TEST ONLY" },
    });
    orgs.push(org.id);
    const user = await db.user.create({ data: { name: "Learning fixture", email: `${crypto.randomUUID()}@example.test`, passwordHash: "not-a-real-hash", memberships: { create: { organizationId: org.id, role: "OWNER" } } } }); users.push(user.id);
    const business = await db.business.create({
      data: {
        organizationId: org.id,
        name: "Fixture Studio",
        confirmedAt: new Date(),
      },
    });
    const scope = {
      businessId: business.id,
      organizationId: org.id,
      actorId: user.id,
    };
    const plan = await db.productionPlan.create({
      data: {
        businessId: business.id,
        organizationId: org.id,
        brandVersion: 1,
        title: "Fixture",
        creditCeiling: 0,
        items: {
          create: {
            title: "Architecture",
            channel: "Facebook",
            format: "static",
            brief: {},
            revisions: {
              create: { version: 1, content: creative, status: "APPROVED" },
            },
          },
        },
      },
      include: { items: { include: { revisions: true } } },
    });
    const connection = await saveVerifiedConnection(scope, {
      provider: "Facebook",
      externalAccountId: business.id,
      label: "Fixture Page",
      token: "never-show-this-token",
      permissions: ["publish"],
      expiresAt: null,
    });
    const action = {
      action: "schedule",
      itemId: plan.items[0].id,
      version: 1,
      connectionId: connection.id,
      scheduledFor: new Date(Date.now() + 120000).toISOString(),
      timezone: "UTC",
    };
    return { scope, connection, action, item: plan.items[0] };
  }
  function adapter(): SocialAdapter {
    return {
      publish: vi.fn(async () => ({
        state: "published" as const,
        receipt: {
          externalPostId: crypto.randomUUID(),
          permalink: "https://facebook.com/fixture",
          publishedAt: new Date(),
        },
      })),
      reconcile: vi.fn(async () => null),
      metrics: vi.fn(async () => ({
        observedAt: new Date(),
        definitionVersion: "fixture-lifetime-v1",
        impressions: 100,
        reach: null,
        engagements: 5,
        clicks: null,
        videoViews: null,
      })),
    };
  }
  async function queue(
    ctx: Awaited<ReturnType<typeof setup>>,
    provider: SocialAdapter
  ) {
    await manageSocial(ctx.scope, ctx.action, { Facebook: provider });
    const post = await db.socialPublication.findFirstOrThrow({
      where: { businessId: ctx.scope.businessId },
    });
    await db.socialPublication.update({
      where: { id: post.id },
      data: { scheduledFor: new Date(Date.now() - 1000) },
    });
    return post;
  }
  async function linkedinQueue() {
    const ctx = await setup(), f = publishingFixture(submissionJournal);
    await db.productionItem.update({ where: { id: ctx.item.id }, data: { channel: "LinkedIn" } });
    await db.socialConnection.update({ where: { id: ctx.connection.id }, data: { provider: "LinkedIn", externalAccountId: f.account.externalAccountId, permissions: [...LINKEDIN_SCOPES], expiresAt: new Date(Date.now() + 3600000) } });
    await manageSocial(ctx.scope, ctx.action, { LinkedIn: f.adapter });
    const post = await db.socialPublication.findFirstOrThrow({ where: { businessId: ctx.scope.businessId } });
    await db.socialPublication.update({ where: { id: post.id }, data: { scheduledFor: new Date(Date.now() - 1000) } });
    f.post.publishedAt = Date.now();
    return { ctx, f, post };
  }
  async function facebookQueue() {
    const ctx = await setup(), f = facebookPublishingFixture(submissionJournal);
    await db.socialConnection.update({ where: { id: ctx.connection.id }, data: { externalAccountId: f.account.externalAccountId, permissions: [...META_SCOPES.Facebook], expiresAt: new Date(Date.now() + 3600000) } });
    const post = await queue(ctx, f.adapter);
    return { ctx, f, post };
  }
  it("publishes a verified Facebook text receipt without inventing metrics or resending", async () => {
    const { f, post } = await facebookQueue();
    await runOnePublication({ Facebook: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", candidatePostId: f.id, externalPostId: f.id, nextMetricsAt: null });
    await runOnePublication({ Facebook: f.adapter });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    const metrics = vi.spyOn(f.adapter, "metrics");
    await db.socialPublication.update({ where: { id: post.id }, data: { nextMetricsAt: new Date(Date.now() - 1000) } });
    expect(await runOneMetricSync({ Facebook: f.adapter })).toBe(false);
    expect(metrics).not.toHaveBeenCalled();
    expect(await db.metricSnapshot.count({ where: { publicationId: post.id } })).toBe(0);
    expect(f.replies).toHaveLength(0);
  });
  it("recovers a known Facebook candidate by reading it without another submission", async () => {
    const { f, post } = await facebookQueue();
    f.replies[3] = new Error("lost read-back");
    await runOnePublication({ Facebook: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", candidatePostId: f.id, externalPostId: null });
    f.replies.push({ data: f.inspectedPage }, f.capability, f.post);
    expect(await reconcilePublication(post.id, { Facebook: f.adapter })).toBe(true);
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", externalPostId: f.id, nextMetricsAt: null });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("holds a Facebook write with a missing response and never searches or resends", async () => {
    const { f, post } = await facebookQueue();
    f.replies.splice(2, 2, new Error("lost submission"));
    await runOnePublication({ Facebook: f.adapter });
    const before = f.fetcher.mock.calls.length;
    expect(await reconcilePublication(post.id, { Facebook: f.adapter })).toBe(false);
    await runOnePublication({ Facebook: f.adapter });
    expect(f.fetcher).toHaveBeenCalledTimes(before);
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", candidatePostId: null, externalPostId: null });
  });
  it("fences Facebook writes once and binds candidate IDs to the selected Page", async () => {
    const { ctx, f, post } = await facebookQueue();
    await db.socialPublication.update({ where: { id: post.id }, data: { status: "SUBMITTING", leaseUntil: new Date(Date.now() + 120000) } });
    const context = { requestId: post.id, account: { ...f.account, id: ctx.connection.id, token: "never-show-this-token" }, payload: f.payload, adapterVersion: "test:publish-v1" };
    expect((await Promise.all([submissionJournal.begin(context), submissionJournal.begin(context)])).sort()).toEqual([false, true]);
    for (const id of ["123_123", "urn:li:share:123", "789_0", "789_123/other"]) await expect(submissionJournal.record(context, id)).rejects.toThrow();
    await submissionJournal.record(context, f.id);
    await submissionJournal.record(context, f.id);
    expect(await submissionJournal.candidate(context)).toBe(f.id);
    await expect(submissionJournal.record(context, "789_999")).rejects.toThrow();
  });
  it("publishes LinkedIn through the real transport and durable journal, then ingests scoped post metrics", async () => {
    const { ctx, f, post } = await linkedinQueue();
    await runOnePublication({ LinkedIn: f.adapter });
    const saved = await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved).toMatchObject({ status: "PUBLISHED", candidatePostId: f.id, externalPostId: f.id, permalink: null });
    expect(saved.submissionAdapterVersion).toContain("publish-v1");
    await runOnePublication({ LinkedIn: f.adapter });
    expect(f.fetcher.mock.calls.filter(([url, init]) => url === "https://api.linkedin.com/rest/posts" && init?.method === "POST")).toHaveLength(1);
    f.replies.push(f.introspection, f.acl, f.post, f.stats);
    await db.socialPublication.update({ where: { id: post.id }, data: { nextMetricsAt: new Date(Date.now() - 1000) } });
    await runOneMetricSync({ LinkedIn: f.adapter });
    const readings = await db.metricSnapshot.findMany({ where: { publicationId: post.id } });
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({ organizationId: ctx.scope.organizationId, businessId: ctx.scope.businessId, impressions: 100, engagements: 6, clicks: 4, reach: null, videoViews: null });
    expect(JSON.stringify(await readSocialDashboard(ctx.scope))).toContain("linkedin-organic-post-likes-comments-shares");
    expect(f.replies).toHaveLength(0);
  });
  it("reconciles a known LinkedIn candidate after read-back failure without another post", async () => {
    const { f, post } = await linkedinQueue();
    f.replies[3] = new Error("lost read-back");
    await runOnePublication({ LinkedIn: f.adapter });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", candidatePostId: f.id, externalPostId: null });
    f.replies.push(f.introspection, f.acl, f.post);
    expect(await reconcilePublication(post.id, { LinkedIn: f.adapter })).toBe(true);
    expect(f.fetcher.mock.calls.filter(([url, init]) => url === "https://api.linkedin.com/rest/posts" && init?.method === "POST")).toHaveLength(1);
    expect((await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("PUBLISHED");
  });
  it("holds a lost LinkedIn submission response without guessing an ID or sending again", async () => {
    const { f, post } = await linkedinQueue();
    f.replies.splice(2, 2, new Error("lost submission response"));
    await runOnePublication({ LinkedIn: f.adapter });
    const before = f.fetcher.mock.calls.length;
    expect(await reconcilePublication(post.id, { LinkedIn: f.adapter })).toBe(false);
    await runOnePublication({ LinkedIn: f.adapter });
    expect(f.fetcher).toHaveBeenCalledTimes(before);
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", candidatePostId: null, externalPostId: null });
  });
  it("atomically fences LinkedIn submissions and rejects mismatched account, payload and receipt contexts", async () => {
    const { f, post, ctx } = await linkedinQueue();
    await db.socialPublication.update({ where: { id: post.id }, data: { status: "SUBMITTING", leaseUntil: new Date(Date.now() + 120000) } });
    const context = { requestId: post.id, account: { ...f.account, id: ctx.connection.id, token: "never-show-this-token" }, payload: f.payload, adapterVersion: "test:publish-v1" };
    await expect(submissionJournal.begin({ ...context, account: { ...context.account, externalAccountId: "urn:li:organization:789" } })).rejects.toThrow();
    await expect(submissionJournal.begin({ ...context, payload: { ...context.payload, caption: "changed" } })).rejects.toThrow();
    expect((await Promise.all([submissionJournal.begin(context), submissionJournal.begin(context)])).sort()).toEqual([false, true]);
    await expect(submissionJournal.record({ ...context, adapterVersion: "different" }, f.id)).rejects.toThrow();
    await submissionJournal.record(context, f.id);
    expect(await submissionJournal.candidate(context)).toBe(f.id);
    await expect(submissionJournal.record(context, "urn:li:share:789")).rejects.toThrow();
    await db.socialPublication.update({ where: { id: post.id }, data: { payload: { ...f.payload, caption: "tampered without hash" } } });
    await expect(submissionJournal.candidate(context)).rejects.toThrow();
  });
  it("discards a receipt when credentials change during submission", async () => {
    const ctx = await setup(), provider = adapter();
    const post = await queue(ctx, provider);
    const original = provider.publish;
    provider.publish = async (...args) => {
      const receipt = await original(...args);
      await db.socialConnection.update({ where: { id: ctx.connection.id }, data: { encryptedToken: "changed" } });
      return receipt;
    };
    await runOnePublication({ Facebook: provider });
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", externalPostId: null, errorCode: "SUBMISSION_CONTEXT_CHANGED" });
  });
  it.each(["credentials", "payload"])("discards metrics when %s change in flight", async change => {
    const ctx = await setup(), provider = adapter();
    const post = await queue(ctx, provider);
    await runOnePublication({ Facebook: provider });
    await db.socialPublication.update({ where: { id: post.id }, data: { nextMetricsAt: new Date(Date.now() - 1000) } });
    const original = provider.metrics;
    provider.metrics = async (...args) => {
      const reading = await original(...args);
      if (change === "credentials") await db.socialConnection.update({ where: { id: ctx.connection.id }, data: { encryptedToken: "changed" } });
      else await db.socialPublication.update({ where: { id: post.id }, data: { payload: { caption: "tampered" } } });
      return reading;
    };
    await runOneMetricSync({ Facebook: provider });
    expect(await db.metricSnapshot.count({ where: { publicationId: post.id } })).toBe(0);
    expect(await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ metricsLeaseUntil: null, nextMetricsAt: null, errorCode: "METRICS_CONTEXT_CHANGED" });
  });
  it("fails closed without an adapter; encrypts tokens and never returns them", async () => {
    const ctx = await setup();
    await expect(manageSocial(ctx.scope, ctx.action, {})).rejects.toThrow(
      "not connected"
    );
    const conn = await db.socialConnection.findUniqueOrThrow({
      where: { id: ctx.connection.id },
    });
    expect(conn.encryptedToken).not.toContain("never-show-this-token");
    expect(JSON.stringify(await readSocialDashboard(ctx.scope))).not.toContain(
      "encryptedToken"
    );
    expect(
      await db.socialPublication.count({
        where: { businessId: ctx.scope.businessId },
      })
    ).toBe(0);
  });
  it("isolates accounts and records; publishing replays never duplicate", async () => {
    const a = await setup(),
      b = await setup(),
      provider = adapter();
    await expect(
      manageSocial(b.scope, a.action, { Facebook: provider })
    ).rejects.toThrow("not found");
    const post = await queue(a, provider);
    await Promise.all([
      runOnePublication({ Facebook: provider }),
      runOnePublication({ Facebook: provider }),
    ]);
    expect(provider.publish).toHaveBeenCalledTimes(1);
    expect(
      (await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } }))
        .status
    ).toBe("PUBLISHED");
    await expect(
      manageSocial(a.scope, a.action, { Facebook: provider })
    ).rejects.toThrow("already been submitted");
    await expect(
      manageSocial(b.scope, { action: "cancel", publicationId: post.id }, {})
    ).rejects.toThrow("not found");
  });
  it("invalidates queued work when the exact copy is edited", async () => {
    const ctx = await setup(),
      provider = adapter();
    const post = await queue(ctx, provider);
    await actOnProduction(ctx.scope, {
      action: "edit",
      itemId: ctx.item.id,
      version: 1,
      headline: creative.headline,
      caption: "Architecture with a considered approach.",
      cta: creative.cta,
    });
    await runOnePublication({ Facebook: provider });
    expect(provider.publish).not.toHaveBeenCalled();
    expect(
      (await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } }))
        .status
    ).toBe("CANCELLED");
  });
  it("never resubmits a timeout and blocks edits until provider read-back", async () => {
    const ctx = await setup(),
      provider = adapter();
    provider.publish = vi.fn(async () => {
      throw Error("timeout after remote write");
    });
    const post = await queue(ctx, provider);
    await runOnePublication({ Facebook: provider });
    await runOnePublication({ Facebook: provider });
    expect(provider.publish).toHaveBeenCalledTimes(1);
    await expect(
      actOnProduction(ctx.scope, {
        action: "edit",
        itemId: ctx.item.id,
        version: 1,
        headline: creative.headline,
        caption: creative.caption,
        cta: creative.cta,
      })
    ).rejects.toThrow("uncertain");
    expect(await reconcilePublication(post.id, { Facebook: provider })).toBe(
      false
    );
    provider.reconcile = vi.fn(async () => ({
      externalPostId: "read-back-id",
      permalink: "https://facebook.com/read-back-id",
      publishedAt: new Date(),
    }));
    await db.socialPublication.update({ where: { id: post.id }, data: { nextReconciliationAt: new Date(Date.now() - 1000) } });
    expect(await reconcilePublication(post.id, { Facebook: provider })).toBe(
      true
    );
    expect(
      (await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } }))
        .externalPostId
    ).toBe("read-back-id");
  });
  it("bounds safe retries, treats malformed receipts as uncertain, and recovers abandoned leases", async () => {
    const ctx = await setup(),
      provider = adapter();
    provider.publish = vi.fn(async () => ({
      state: "retryable" as const,
      code: "RATE_LIMIT" as const,
      retryAfterSeconds: 1,
    }));
    const post = await queue(ctx, provider);
    for (let n = 0; n < 3; n++) {
      await db.socialPublication.update({
        where: { id: post.id },
        data: { scheduledFor: new Date(Date.now() - 1000) },
      });
      await runOnePublication({ Facebook: provider });
    }
    expect(provider.publish).toHaveBeenCalledTimes(3);
    expect(
      (await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } }))
        .status
    ).toBe("FAILED");
    const other = await setup(),
      invalid = adapter();
    invalid.publish = vi.fn(async () => ({
      state: "published" as const,
      receipt: {
        externalPostId: "bad",
        permalink: "https://evil.test/post",
        publishedAt: new Date(),
      },
    }));
    const bad = await queue(other, invalid);
    await runOnePublication({ Facebook: invalid });
    expect(
      (await db.socialPublication.findUniqueOrThrow({ where: { id: bad.id } }))
        .status
    ).toBe("NEEDS_RECONCILIATION");
    await db.socialPublication.update({
      where: { id: bad.id },
      data: { status: "SUBMITTING", leaseUntil: new Date(Date.now() - 1000) },
    });
    await recoverSocialLeases();
    expect(
      (await db.socialPublication.findUniqueOrThrow({ where: { id: bad.id } }))
        .status
    ).toBe("NEEDS_RECONCILIATION");
  });
  it("deduplicates metrics, preserves nulls, and refuses learning without evidence", async () => {
    const ctx = await setup(),
      provider = adapter(),
      post = await queue(ctx, provider);
    await runOnePublication({ Facebook: provider });
    const observedAt = new Date();
    provider.metrics = vi.fn(async () => ({
      observedAt,
      definitionVersion: "fixture-v1",
      impressions: 100,
      engagements: 5,
      reach: null,
      clicks: null,
      videoViews: null,
    }));
    for (let n = 0; n < 2; n++) {
      await db.socialPublication.update({
        where: { id: post.id },
        data: { nextMetricsAt: new Date(Date.now() - 1000) },
      });
      await runOneMetricSync({ Facebook: provider });
    }
    expect(
      await db.metricSnapshot.count({ where: { publicationId: post.id } })
    ).toBe(1);
    const dashboard = await readSocialDashboard(ctx.scope);
    expect(dashboard.summary[0].metrics.impressions.value).toBe(100);
    expect(dashboard.summary[0].metrics.clicks.value).toBeNull();
    await expect(
      manageLearning(ctx.scope, { action: "evaluate" })
    ).rejects.toThrow("Insufficient");
  });
  it("requires current-brand human promotion, deduplicates concurrent decisions and precisely reverts memory", async () => {
    const ctx = await setup(), other = await setup();
    await seedLearningEvidence(db, { ...ctx.scope, connectionId: ctx.connection.id, planId: ctx.item.planId });
    const proposal = await manageLearning(ctx.scope, { action: "evaluate" }) as { id: string };
    await expect(manageLearning(other.scope, { action: "promote", proposalId: proposal.id })).rejects.toThrow("not found");
    const result = await Promise.allSettled([0, 1].map(() => manageLearning(ctx.scope, { action: "promote", proposalId: proposal.id })));
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.memory.count({ where: { businessId: ctx.scope.businessId, kind: "APPROVED_EXPERIMENT" } })).toBe(1);
    const preference = await db.memory.create({ data: { businessId: ctx.scope.businessId, organizationId: ctx.scope.organizationId, kind: "PREFERENCE", text: "Keep this explicit preference" } });
    await manageLearning(ctx.scope, { action: "revert", proposalId: proposal.id });
    expect(await db.memory.count({ where: { businessId: ctx.scope.businessId, kind: "APPROVED_EXPERIMENT" } })).toBe(0);
    expect(await db.memory.findUnique({ where: { id: preference.id } })).not.toBeNull();
    await expect(manageLearning(ctx.scope, { action: "promote", proposalId: proposal.id })).rejects.toThrow("current-brand");
    const stale = await db.learningProposal.create({ data: { businessId: ctx.scope.businessId, organizationId: ctx.scope.organizationId, brandVersion: 1, hypothesis: "Stale fixture", evidence: {} } });
    await db.business.update({ where: { id: ctx.scope.businessId }, data: { version: 2 } });
    await expect(manageLearning(ctx.scope, { action: "promote", proposalId: stale.id })).rejects.toThrow("current-brand");
  });
  it.each(["removed snapshot", "changed count", "changed definition", "tampered payload", "old brand", "disconnected account", "changed hypothesis"])("blocks promotion after %s", async reason => {
    const ctx = await setup(), fixture = await seedLearningEvidence(db, { ...ctx.scope, connectionId: ctx.connection.id, planId: ctx.item.planId });
    const proposal = await manageLearning(ctx.scope, { action: "evaluate" }) as { id: string };
    if (reason === "removed snapshot") await db.metricSnapshot.delete({ where: { id: fixture[0].metric.id } });
    if (reason === "changed count") await db.metricSnapshot.update({ where: { id: fixture[0].metric.id }, data: { engagements: 51 } });
    if (reason === "changed definition") await db.metricSnapshot.update({ where: { id: fixture[0].metric.id }, data: { definitionVersion: "different" } });
    if (reason === "tampered payload") await db.socialPublication.update({ where: { id: fixture[0].post.id }, data: { payloadHash: "changed" } });
    if (reason === "old brand") await db.socialPublication.update({ where: { id: fixture[0].post.id }, data: { brandVersion: 2 } });
    if (reason === "disconnected account") await db.socialConnection.update({ where: { id: ctx.connection.id }, data: { status: "DISCONNECTED" } });
    if (reason === "changed hypothesis") await db.learningProposal.update({ where: { id: proposal.id }, data: { hypothesis: "Spend without review" } });
    await expect(manageLearning(ctx.scope, { action: "promote", proposalId: proposal.id })).rejects.toThrow("evidence");
    expect(await db.memory.count({ where: { businessId: ctx.scope.businessId } })).toBe(0);
    expect(await db.reservation.count({ where: { organizationId: ctx.scope.organizationId } })).toBe(0);
  });
  it("excludes invalid promoted or legacy experiments from production, preserving explicit preferences", async () => {
    const ctx = await setup(), fixture = await seedLearningEvidence(db, { ...ctx.scope, connectionId: ctx.connection.id, planId: ctx.item.planId });
    const result = await manageLearning(ctx.scope, { action: "evaluate" }) as { id: string };
    await manageLearning(ctx.scope, { action: "promote", proposalId: result.id });
    const proposal = await db.learningProposal.findUniqueOrThrow({ where: { id: result.id } });
    await db.memory.createMany({ data: [{ ...ctx.scope, actorId: undefined, kind: "PREFERENCE", text: "Explicit preference" }, { ...ctx.scope, actorId: undefined, kind: "APPROVED_EXPERIMENT", text: "Legacy unsupported experiment" }].map(({ actorId: _actor, ...m }) => m) });
    const read = () => db.$transaction(tx => productionMemories(tx, ctx.scope, 1));
    expect((await read()).map(m => m.text)).toEqual(expect.arrayContaining(["Explicit preference", proposal.hypothesis]));
    expect((await read()).some(m => m.text.startsWith("Legacy"))).toBe(false);
    expect(await db.$transaction(tx => validLearningEvidence(tx, ctx.scope, 1, proposal.evidence, proposal.hypothesis, new Date(Date.now() + 8 * 86400000)))).toBe(false);
    expect((await db.$transaction(tx => productionMemories(tx, ctx.scope, 1, new Date(Date.now() + 31 * 86400000)))).map(m => m.text)).toEqual(["Explicit preference"]);
    await db.metricSnapshot.delete({ where: { id: fixture[0].metric.id } });
    expect((await read()).map(m => m.text)).toEqual(["Explicit preference"]);
  });
  it("rechecks current role, rejects legacy evidence and allows fresh evaluation", async () => {
    const ctx = await setup(); await seedLearningEvidence(db, { ...ctx.scope, connectionId: ctx.connection.id, planId: ctx.item.planId });
    const legacy = await db.learningProposal.create({ data: { businessId: ctx.scope.businessId, organizationId: ctx.scope.organizationId, brandVersion: 1, hypothesis: "Legacy", evidence: {} } });
    await expect(manageLearning(ctx.scope, { action: "promote", proposalId: legacy.id })).rejects.toThrow("evidence");
    const results = await Promise.all([0, 1].map(() => manageLearning(ctx.scope, { action: "evaluate" }))) as { id: string }[];
    expect(results[0].id).toBe(results[1].id);
    await db.membership.updateMany({ where: { organizationId: ctx.scope.organizationId }, data: { role: "VIEWER" } });
    await expect(manageLearning(ctx.scope, { action: "promote", proposalId: results[0].id })).rejects.toThrow("role");
  });
  it("disconnect cancels pending work and erases token ciphertext", async () => {
    const ctx = await setup(),
      provider = adapter(),
      post = await queue(ctx, provider);
    await manageSocial(
      ctx.scope,
      { action: "disconnect", connectionId: ctx.connection.id },
      {}
    );
    expect(
      (
        await db.socialConnection.findUniqueOrThrow({
          where: { id: ctx.connection.id },
        })
      ).encryptedToken
    ).toBe("");
    expect(
      (await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } }))
        .status
    ).toBe("CANCELLED");
  });
  it.each(["shape", "hash", "media", "format"])("quarantines %s corruption before submission without blocking later posts", async kind => {
    const ctx = await setup(), provider = adapter(), post = await queue(ctx, provider);
    const valid = { caption: creative.caption, channel: "Facebook", format: "static", mediaExportId: null };
    const payload = kind === "shape" ? { bad: true } : kind === "media" ? { ...valid, mediaExportId: "unverified" } : kind === "format" ? { ...valid, format: "video" } : valid;
    await db.socialPublication.update({ where: { id: post.id }, data: { payload, payloadHash: kind === "shape" || kind === "hash" ? "invalid" : payloadHash(payload) } });
    expect(await runOnePublication({ Facebook: provider })).toBe(true);
    expect(provider.publish).not.toHaveBeenCalled();
    expect(await db.socialPublication.findUnique({ where: { id: post.id } })).toMatchObject({ status: "CANCELLED", errorCode: "PAYLOAD_INVALID", attempts: 0 });
    const next = await setup(); await queue(next, provider); await runOnePublication({ Facebook: provider });
    expect(provider.publish).toHaveBeenCalledTimes(1);
  });
  it("handles invalid copy and undecryptable credentials without network writes or queue poisoning", async () => {
    const a = await setup(), provider = adapter(), post = await queue(a, provider);
    await db.creativeRevision.update({ where: { id: post.revisionId }, data: { content: {} } });
    await runOnePublication({ Facebook: provider });
    expect(await db.socialPublication.findUnique({ where: { id: post.id } })).toMatchObject({ status: "CANCELLED", errorCode: "PAYLOAD_INVALID" });
    const b = await setup(), badKey = await queue(b, provider);
    await db.socialConnection.update({ where: { id: b.connection.id }, data: { encryptedToken: "invalid-envelope" } });
    await runOnePublication({ Facebook: provider });
    expect(await db.socialPublication.findUnique({ where: { id: badKey.id } })).toMatchObject({ status: "FAILED", errorCode: "CREDENTIAL_UNAVAILABLE", attempts: 0 });
    expect(provider.publish).not.toHaveBeenCalled();
  });
  it("allows date changes but refuses to replace the immutable payload of a saved publication", async () => {
    const ctx = await setup(), provider = adapter(), post = await queue(ctx, provider);
    await manageSocial(ctx.scope, { ...ctx.action, scheduledFor: new Date(Date.now() + 240000).toISOString() }, { Facebook: provider });
    const moved = await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } });
    expect(moved.payload).toEqual(post.payload); expect(moved.payloadHash).toBe(post.payloadHash);
    await db.creativeRevision.update({ where: { id: post.revisionId }, data: { content: { ...creative, caption: "Architecture consultations for your home." } } });
    await expect(manageSocial(ctx.scope, ctx.action, { Facebook: provider })).rejects.toThrow("different content");
    expect((await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } })).payload).toEqual(post.payload);
    expect(provider.publish).not.toHaveBeenCalled();
  });
  async function uncertain() {
    const ctx = await setup(), provider = adapter();
    provider.publish = vi.fn(async () => ({ state: "uncertain" as const }));
    const post = await queue(ctx, provider); await runOnePublication({ Facebook: provider });
    return { ctx, provider, post };
  }
  it("bounds lookup retries with persisted backoff and never resubmits an uncertain post", async () => {
    const { provider, post } = await uncertain();
    for (let n = 1; n <= MAX_RECONCILIATION_ATTEMPTS; n++) {
      expect(await runOneReconciliation({ Facebook: provider })).toBe(true);
      const fresh = await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } });
      expect(fresh).toMatchObject({ status: "NEEDS_RECONCILIATION", reconciliationAttempts: n, leaseUntil: null });
      expect(provider.reconcile).toHaveBeenCalledTimes(n);
      expect(await runOneReconciliation({ Facebook: provider })).toBe(false);
      if (n < MAX_RECONCILIATION_ATTEMPTS) {
        expect(fresh.nextReconciliationAt!.getTime()).toBeGreaterThan(Date.now() + 55000);
        await db.socialPublication.update({ where: { id: post.id }, data: { nextReconciliationAt: new Date(Date.now() - 1000) } });
      } else expect(fresh.nextReconciliationAt).toBeNull();
    }
    await runOnePublication({ Facebook: provider }); expect(provider.publish).toHaveBeenCalledTimes(1);
  });
  it("leases concurrent lookup calls and atomically records one receipt and audit event", async () => {
    const { provider, post } = await uncertain();
    let release!: () => void, started!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
    provider.reconcile = vi.fn(async () => { started(); await barrier; return { externalPostId: crypto.randomUUID(), permalink: "https://facebook.com/readback", publishedAt: new Date() }; });
    const first = reconcilePublication(post.id, { Facebook: provider }); await entered;
    expect(await reconcilePublication(post.id, { Facebook: provider })).toBe(false);
    release(); expect(await first).toBe(true);
    expect(provider.reconcile).toHaveBeenCalledTimes(1);
    expect(await db.auditEvent.count({ where: { businessId: post.businessId, action: "SOCIAL_RECONCILED" } })).toBe(1);
    expect(await db.socialPublication.findUnique({ where: { id: post.id } })).toMatchObject({ status: "PUBLISHED", reconciliationAttempts: 1, leaseUntil: null, nextReconciliationAt: null });
  });
  it.each(["payload", "expired", "key"])("stops %s lookup failures for operator attention without using the provider", async kind => {
    const { ctx, provider, post } = await uncertain();
    if (kind === "payload") await db.socialPublication.update({ where: { id: post.id }, data: { payloadHash: "changed" } });
    else await db.socialConnection.update({ where: { id: ctx.connection.id }, data: kind === "expired" ? { expiresAt: new Date(Date.now() - 1000) } : { encryptedToken: "bad" } });
    expect(await reconcilePublication(post.id, { Facebook: provider })).toBe(false);
    expect(provider.reconcile).not.toHaveBeenCalled();
    expect(await runOneReconciliation({ Facebook: provider })).toBe(false);
    expect(await db.socialPublication.findUnique({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", nextReconciliationAt: null, leaseUntil: null });
  });
  it("rejects changed destination context after a successful remote lookup", async () => {
    const { ctx, provider, post } = await uncertain();
    provider.reconcile = vi.fn(async () => {
      await db.socialConnection.update({ where: { id: ctx.connection.id }, data: { externalAccountId: "changed-during-lookup" } });
      return { externalPostId: "wrong-context", permalink: null, publishedAt: new Date() };
    });
    expect(await reconcilePublication(post.id, { Facebook: provider })).toBe(false);
    expect(await db.socialPublication.findUnique({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", errorCode: "RECONCILIATION_CONTEXT_CHANGED", externalPostId: null });
    expect(await db.auditEvent.count({ where: { businessId: post.businessId, action: "SOCIAL_RECONCILED" } })).toBe(0);
  });
  it("rejects unsafe receipts and preserves the hold after lookup timeouts", async () => {
    const { provider, post } = await uncertain();
    provider.reconcile = vi.fn(async () => ({ externalPostId: "bad-url", permalink: "https://evil.test/post", publishedAt: new Date() }));
    expect(await reconcilePublication(post.id, { Facebook: provider })).toBe(false);
    await db.socialPublication.update({ where: { id: post.id }, data: { nextReconciliationAt: new Date(Date.now() - 1000) } });
    provider.reconcile = vi.fn(async () => { throw Error("secret provider body must not be persisted"); });
    expect(await reconcilePublication(post.id, { Facebook: provider })).toBe(false);
    const fresh = await db.socialPublication.findUniqueOrThrow({ where: { id: post.id } });
    expect(fresh).toMatchObject({ status: "NEEDS_RECONCILIATION", errorCode: "RECONCILIATION_UNVERIFIED", externalPostId: null, reconciliationAttempts: 2 });
    expect(JSON.stringify(fresh)).not.toContain("secret provider body");
    expect(provider.publish).toHaveBeenCalledTimes(1);
  });
  it("reclaims crashed lookup leases but ignores completions from a replaced lease", async () => {
    const { provider, post } = await uncertain();
    await db.socialPublication.update({ where: { id: post.id }, data: { reconciliationAttempts: 1, leaseUntil: new Date(Date.now() - 1000), nextReconciliationAt: new Date(Date.now() - 1000) } });
    provider.reconcile = vi.fn(async () => {
      await db.socialPublication.update({ where: { id: post.id }, data: { reconciliationAttempts: 3, leaseUntil: new Date(Date.now() + 300000) } });
      return { externalPostId: "late-result", permalink: null, publishedAt: new Date() };
    });
    expect(await reconcilePublication(post.id, { Facebook: provider })).toBe(false);
    expect(provider.reconcile).toHaveBeenCalledTimes(1);
    expect(await db.socialPublication.findUnique({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", externalPostId: null, reconciliationAttempts: 3 });
  });
  it("requires explicit audited operator evidence to resume exhausted lookup and deduplicates repeats", async () => {
    const { provider, post } = await uncertain();
    const input = { publicationId: post.id, operatorId: "fixture-operator", evidence: "Account and immutable snapshot checked in test." };
    await expect(resumePublicationLookup({ ...input, evidence: "" })).rejects.toThrow();
    await db.socialPublication.update({ where: { id: post.id }, data: { reconciliationAttempts: 5, nextReconciliationAt: null } });
    const results = await Promise.all([resumePublicationLookup(input), resumePublicationLookup(input)]);
    expect(results.filter(r => r.resumed)).toHaveLength(1);
    expect(await db.auditEvent.count({ where: { businessId: post.businessId, action: "SOCIAL_LOOKUP_RESUMED" } })).toBe(1);
    expect(await db.socialPublication.findUnique({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", externalPostId: null, reconciliationAttempts: 0 });
    expect(provider.publish).toHaveBeenCalledTimes(1);
  });
  it("makes an interrupted final lookup visibly stopped rather than promising another attempt", async () => {
    const { provider, post } = await uncertain();
    await db.socialPublication.update({ where: { id: post.id }, data: { reconciliationAttempts: 5, leaseUntil: new Date(Date.now() - 1000), nextReconciliationAt: new Date(Date.now() - 1000) } });
    await recoverSocialLeases();
    expect(await runOneReconciliation({ Facebook: provider })).toBe(false);
    expect(await db.socialPublication.findUnique({ where: { id: post.id } })).toMatchObject({ status: "NEEDS_RECONCILIATION", errorCode: "LOOKUP_INTERRUPTED_LIMIT", leaseUntil: null, nextReconciliationAt: null });
    expect(provider.reconcile).not.toHaveBeenCalled();
  });
  it("refuses operator lookup resumption for corrupt snapshots, active leases and confirmed outcomes", async () => {
    const { post } = await uncertain(), input = { publicationId: post.id, operatorId: "fixture-operator", evidence: "Fixture recovery check only." };
    await db.socialPublication.update({ where: { id: post.id }, data: { reconciliationAttempts: 5, payloadHash: "corrupt" } });
    await expect(resumePublicationLookup(input)).rejects.toThrow("immutable");
    await db.socialPublication.update({ where: { id: post.id }, data: { leaseUntil: new Date(Date.now() + 120000) } });
    await expect(resumePublicationLookup(input)).rejects.toThrow("active lookup");
    await db.socialPublication.update({ where: { id: post.id }, data: { status: "PUBLISHED", externalPostId: "already-recorded", publishedAt: new Date(), leaseUntil: null } });
    await expect(resumePublicationLookup(input)).rejects.toThrow("unconfirmed");
  });
});
