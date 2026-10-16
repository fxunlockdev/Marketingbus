import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { db } from "../src/lib/db";
import { uploadAsset, changeAsset } from "../src/lib/assets/service";
import {
  manageComposition,
  exportComposition,
} from "../src/lib/composition/service";
import { actOnProduction } from "../src/lib/production/service";
import type { AssetStore } from "../src/lib/assets/storage";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (
  process.env.TEST_DATABASE_URL &&
  (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL ||
    !["localhost", "127.0.0.1"].includes(
      new URL(process.env.TEST_DATABASE_URL).hostname
    ))
)
  throw Error("Local test DB required");
suite("approved asset compositions", () => {
  const users: string[] = [];
  const ids: string[] = [],
    objects = new Map<string, Buffer>();
  const store: AssetStore = {
    put: async (key, bytes) => {
      objects.set(key, bytes);
    },
    get: async (key) => objects.get(key)!,
    remove: async (key) => {
      objects.delete(key);
    },
  };
  afterAll(async () => {
    await db.brandAsset.deleteMany({ where: { organizationId: { in: ids } } });
    await db.organization.deleteMany({ where: { id: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  });
  async function setup() {
    const org = await db.organization.create({
      data: { name: "COMPOSITION FIXTURE" },
    });
    ids.push(org.id);
    const user = await db.user.create({ data: { email: `composition-${crypto.randomUUID()}@example.test`, name: "Local composition fixture", passwordHash: "not-a-login" } });
    users.push(user.id);
    await db.membership.create({ data: { userId: user.id, organizationId: org.id, role: "OWNER" } });
    const business = await db.business.create({
      data: { organizationId: org.id, name: "Brand", confirmedAt: new Date() },
    });
    const scope = {
      businessId: business.id,
      organizationId: org.id,
      actorId: user.id,
    };
    const plan = await db.productionPlan.create({
      data: {
        organizationId: org.id,
        businessId: business.id,
        brandVersion: 1,
        title: "Design",
        creditCeiling: 0,
        items: {
          create: {
            title: "Brand image",
            channel: "Facebook",
            format: "static",
            brief: {},
            revisions: {
              create: {
                version: 1,
                status: "APPROVED",
                content: {
                  headline: "Made for home",
                  caption: "Considered design for your home.",
                  cta: "Meet us",
                  visualDirection: "Approved brand images",
                  rationale: "A clear invitation",
                  evidenceUsed: [],
                },
              },
            },
          },
        },
      },
      include: { items: true },
    });
    const image = await sharp({
      create: { width: 120, height: 60, channels: 4, background: "#dd3344" },
    })
      .png()
      .toBuffer();
    const uploaded = await uploadAsset(
      scope,
      { label: "Approved logo", purpose: "logo", rightsConfirmed: true },
      image,
      store
    );
    return { scope, itemId: plan.items[0].id, assetId: uploaded.asset.id };
  }
  it("uses approved assets only and requires separate visual approval for export", async () => {
    const ctx = await setup();
    await changeAsset(ctx.scope, ctx.assetId, {
      action: "approve",
      approved: true,
    });
    const made = await manageComposition(ctx.scope, {
      action: "create",
      itemId: ctx.itemId,
      revisionVersion: 1,
    });
    expect(JSON.stringify(made.composition.document)).toContain(ctx.assetId);
    await expect(
      exportComposition(ctx.scope, made.composition.id, "square", false, store)
    ).rejects.toThrow("Approve");
    expect(
      (
        await exportComposition(
          ctx.scope,
          made.composition.id,
          "square",
          true,
          store
        )
      ).width
    ).toBe(1080);
    await manageComposition(ctx.scope, {
      action: "approve",
      rendererVersion: "static-outlines-v2",
      itemId: ctx.itemId,
      version: 1,
    });
    expect(
      (
        await exportComposition(
          ctx.scope,
          made.composition.id,
          "portrait",
          false,
          store
        )
      ).height
    ).toBe(1350);
    await changeAsset(ctx.scope, ctx.assetId, {
      action: "approve",
      approved: false,
    });
    await expect(
      exportComposition(ctx.scope, made.composition.id, "square", false, store)
    ).rejects.toThrow("permission revoked");
  });
  it("isolates tenants and invalidates exports after copy or canvas revisions", async () => {
    const a = await setup(),
      b = await setup();
    const made = await manageComposition(a.scope, {
      action: "create",
      itemId: a.itemId,
      revisionVersion: 1,
    });
    expect(JSON.stringify(made.composition.document)).not.toContain(a.assetId);
    await expect(
      exportComposition(b.scope, made.composition.id, "square", true, store)
    ).rejects.toThrow("not found");
    await manageComposition(a.scope, {
      action: "edit",
      itemId: a.itemId,
      version: 1,
      document: made.composition.document,
    });
    await expect(
      manageComposition(a.scope, {
        action: "approve",
        rendererVersion: "static-outlines-v2",
        itemId: a.itemId,
        version: 1,
      })
    ).rejects.toThrow("changed");
    await expect(
      exportComposition(a.scope, made.composition.id, "square", true, store)
    ).rejects.toThrow("changed");
    await actOnProduction(a.scope, {
      action: "edit",
      itemId: a.itemId,
      version: 1,
      headline: "A considered home",
      caption: "Design for your home.",
      cta: "Meet us",
    });
    await expect(
      manageComposition(a.scope, {
        action: "approve",
        rendererVersion: "static-outlines-v2",
        itemId: a.itemId,
        version: 2,
      })
    ).rejects.toThrow("current copy");
  });
});
