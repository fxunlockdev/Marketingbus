import { afterAll, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { readReviewMedia } from "../src/lib/production/review";
import { MOTION_RENDERER_VERSION } from "../src/lib/video/version";
import { STATIC_RENDERER_VERSION } from "../src/lib/composition/version";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local fixture DB required");

suite("unified review media projection", () => {
  const orgs: string[] = [], users: string[] = [];
  const document = { title: "Studio reel", background: "#112233", logo: null, shots: [{ id: "first", label: "Opening", caption: "Considered spaces", durationMs: 3000, motion: "hold", asset: null }] };
  afterAll(async () => {
    await db.motionRender.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.brandAsset.deleteMany({ where: { organizationId: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.user.deleteMany({ where: { id: { in: users } } }); await db.$disconnect();
  });
  async function setup() {
    const user = await db.user.create({ data: { name: "Review fixture", email: `review-${crypto.randomUUID()}@example.test`, passwordHash: "no-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "Review fixture", wallet: { create: {} }, memberships: { create: { userId: user.id, role: "OWNER" } } } }); orgs.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Review studio", confirmedAt: new Date() } });
    const scope = { businessId: business.id, organizationId: org.id, actorId: user.id };
    const plan = await db.productionPlan.create({ data: { businessId: business.id, organizationId: org.id, brandVersion: 1, title: "Current plan", creditCeiling: 0, items: { create: { title: "Studio consultation", channel: "Instagram", format: "static", brief: { privatePrompt: "PRIVATE_MARKER" }, revisions: { create: { version: 1, status: "APPROVED", content: {} } } } } }, include: { items: { include: { revisions: true } } } });
    const item = plan.items[0], revision = item.revisions[0], fields = { businessId: business.id, organizationId: org.id, itemId: item.id, brandVersion: 1, version: 1 };
    const image = await db.imageGeneration.create({ data: { ...fields, revisionId: revision.id, actorId: user.id, prompt: "PRIVATE_MARKER", references: [], route: { secret: "PRIVATE_MARKER" }, configurationHash: "PRIVATE_MARKER", credits: 1, supplierCeilingMicros: 1, expiresAt: new Date(), status: "READY" } });
    await db.brandAsset.create({ data: { businessId: business.id, organizationId: org.id, generationId: image.id, objectKey: `PRIVATE_MARKER/${crypto.randomUUID()}`, purpose: "generated", label: "Supporting artwork", sha256: "a".repeat(64), bytes: 100, width: 100, height: 100, status: "READY", uploadedBy: user.id, rightsConfirmedAt: new Date() } });
    const layout = await db.staticComposition.create({ data: { ...fields, revisionId: revision.id, document: { secret: "PRIVATE_MARKER" }, status: "APPROVED", approvedRendererVersion: STATIC_RENDERER_VERSION } });
    const board = await db.videoStoryboard.create({ data: { ...fields, copyRevisionId: revision.id, document, shotApprovals: [], authorId: user.id, status: "APPROVED" } });
    const render = await db.motionRender.create({ data: { businessId: business.id, organizationId: org.id, storyboardId: board.id, rendererVersion: MOTION_RENDERER_VERSION, documentHash: "a".repeat(64), objectKey: `PRIVATE_MARKER/${crypto.randomUUID()}`, status: "READY", bytes: 100, durationMs: 3000, createdBy: user.id, purgeAfter: new Date(Date.now() + 86400000) } });
    return { scope, plan, item, revision, image, layout, board, render };
  }
  it("joins exact current image, layout and video without storage, prompt or provider secrets", async () => {
    const f = await setup(), result = await readReviewMedia(f.scope, { plan: f.plan.id });
    expect(result.canEdit).toBe(true); expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ itemId: f.item.id, image: { id: f.image.id, previewable: true }, composition: { id: f.layout.id, approved: true, previewable: true }, video: { id: f.board.id, format: "portrait", hasMusic: false, render: { id: f.render.id, previewable: true } } });
    expect(result.items[0].video?.captions).toContain("WEBVTT");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_MARKER");
    expect(await db.job.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
    expect(await db.auditEvent.count({ where: { businessId: f.scope.businessId } })).toBe(0);
  });
  it("cannot read another tenant, another business in the same tenant, or a nonmember", async () => {
    const a = await setup(), b = await setup();
    await expect(readReviewMedia(b.scope, { plan: a.plan.id })).rejects.toThrow("Plan not found");
    await expect(readReviewMedia({ ...a.scope, actorId: b.scope.actorId }, { plan: a.plan.id })).rejects.toThrow("Business not found");
    const sibling = await db.business.create({ data: { organizationId: a.scope.organizationId, name: "Other business" } });
    await expect(readReviewMedia({ ...a.scope, businessId: sibling.id }, { plan: a.plan.id })).rejects.toThrow("Plan not found");
  });
  it("keeps viewer media readable while withholding editing permission", async () => {
    const f = await setup(); await db.membership.update({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } }, data: { role: "VIEWER" } });
    const result = await readReviewMedia(f.scope, { plan: f.plan.id }); expect(result.canEdit).toBe(false); expect(result.items[0].image?.previewable).toBe(true);
  });
  it.each(["copy", "unconfirmed", "brand", "plan"])("marks media stale after %s changes without falling back to older approvals", async reason => {
    const f = await setup();
    if (reason === "copy") await db.creativeRevision.create({ data: { itemId: f.item.id, organizationId: f.scope.organizationId, version: 2, status: "APPROVED", content: {} } });
    if (reason === "unconfirmed") await db.business.update({ where: { id: f.scope.businessId }, data: { confirmedAt: null } });
    if (reason === "brand") await db.business.update({ where: { id: f.scope.businessId }, data: { version: 2 } });
    if (reason === "plan") await db.productionPlan.update({ where: { id: f.plan.id }, data: { status: "SUPERSEDED" } });
    const row = (await readReviewMedia(f.scope, { plan: f.plan.id })).items[0];
    expect(row.image?.current).toBe(false); expect(row.composition?.current).toBe(false); expect(row.video?.current).toBe(false);
    expect(row.image?.previewable).toBe(false); expect(row.composition?.previewable).toBe(false); expect(row.video?.render?.previewable).toBe(false); expect(row.video?.captions).toBeNull();
  });
  it("returns the latest draft instead of an earlier approved layout or storyboard", async () => {
    const f = await setup();
    await db.staticComposition.create({ data: { businessId: f.scope.businessId, organizationId: f.scope.organizationId, itemId: f.item.id, revisionId: f.revision.id, brandVersion: 1, version: 2, document: {}, status: "DRAFT" } });
    await db.videoStoryboard.create({ data: { businessId: f.scope.businessId, organizationId: f.scope.organizationId, itemId: f.item.id, copyRevisionId: f.revision.id, brandVersion: 1, version: 2, document, shotApprovals: [], authorId: f.scope.actorId } });
    const row = (await readReviewMedia(f.scope, { plan: f.plan.id })).items[0];
    expect(row.composition).toMatchObject({ version: 2, approved: false }); expect(row.video).toMatchObject({ version: 2, render: null });
  });
  it.each(["expired", "archived", "renderer", "malformed-board"])("does not offer %s video for preview", async reason => {
    const f = await setup();
    if (reason === "expired") await db.motionRender.update({ where: { id: f.render.id }, data: { purgeAfter: new Date(0) } });
    if (reason === "archived") await db.motionRender.update({ where: { id: f.render.id }, data: { status: "ARCHIVED" } });
    if (reason === "renderer") await db.motionRender.update({ where: { id: f.render.id }, data: { rendererVersion: "old-renderer" } });
    if (reason === "malformed-board") await db.videoStoryboard.update({ where: { id: f.board.id }, data: { document: {} } });
    expect((await readReviewMedia(f.scope, { plan: f.plan.id })).items[0].video?.render?.previewable ?? false).toBe(false);
  });
  it("does not require separate copy to show a motion-only creative", async () => {
    const f = await setup(); await db.brandAsset.deleteMany({ where: { generationId: f.image.id } }); await db.imageGeneration.deleteMany({ where: { itemId: f.item.id } });
    await db.videoStoryboard.update({ where: { id: f.board.id }, data: { copyRevisionId: null } });
    await db.creativeRevision.deleteMany({ where: { itemId: f.item.id } });
    const row = (await readReviewMedia(f.scope, { plan: f.plan.id })).items[0]; expect(row.video?.current).toBe(true); expect(row.video?.render?.previewable).toBe(true); expect(row.composition?.current).toBe(false);
  });
  it("rejects missing, extra or malformed query input", async () => {
    const f = await setup();
    for (const raw of [{}, { plan: "" }, { plan: "x".repeat(101) }, { plan: f.plan.id, take: 9999 }, { plan: "missing" }]) await expect(readReviewMedia(f.scope, raw)).rejects.toThrow();
  });
});
