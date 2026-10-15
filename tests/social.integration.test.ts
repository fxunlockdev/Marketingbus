import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
} from "../src/lib/social/worker";
import { actOnProduction } from "../src/lib/production/service";
import {
  readSocialDashboard,
  manageLearning,
} from "../src/lib/social/analytics";
import type { SocialAdapter } from "../src/lib/social/contracts";
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
    vi.unstubAllEnvs();
    await db.$disconnect();
  });
  async function setup() {
    const org = await db.organization.create({
      data: { name: "SOCIAL TEST ONLY" },
    });
    orgs.push(org.id);
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
      actorId: "test",
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
    const proposal = await db.learningProposal.create({ data: {
      businessId: ctx.scope.businessId, organizationId: ctx.scope.organizationId,
      brandVersion: 1, hypothesis: "Fixture experiment; not a causal finding", evidence: { kind: "TEST_ONLY" },
    } });
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
});
