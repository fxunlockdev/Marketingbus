import { z } from "zod";
import { createHash } from "node:crypto";
import { db } from "../db";
import { AppError } from "../http";
import { brandInput, draftBrandInput, proposePlan } from "../brand";
import { contentPreferences } from "./preferences";
import { lockBusiness, type Scope } from "../production/service";
import { assertBrandEditor } from "../knowledge/analysis";
import { replaceBrandProfile } from "../knowledge/profile";
import { publicUrl } from "../providers/url-policy";
import { setupDetails, socialAddress, websiteAddress } from "./simple";

const requiredWebsite = z.string().trim().min(1, "Enter your business website.").max(500).transform((value, ctx) => {
  try { return publicUrl(websiteAddress(value)).href; } catch { ctx.addIssue({ code: "custom", message: "Enter a public HTTPS business website." }); return z.NEVER; }
});

export const draftProfile = draftBrandInput;
const startInput = z.object({ organizationId: z.string().min(1), requestId: z.uuid(),
  name: brandInput.shape.name, website: requiredWebsite, industry: brandInput.shape.industry }).strict();
const connectionDraftInput = z.object({ organizationId: z.string().min(1), requestId: z.uuid(), name: brandInput.shape.name }).strict();
const actionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("simple-save"), revision: z.number().int().positive(), version: z.number().int().positive(),
    step: z.union([z.literal(1), z.literal(2), z.literal(5)]), profile: draftProfile.extend({ website: requiredWebsite }), details: setupDetails }).strict(),
  z.object({ action: z.literal("save"), revision: z.number().int().positive(), version: z.number().int().positive(), step: z.number().int().min(1).max(5), profile: draftProfile }).strict(),
  z.object({ action: z.literal("finish"), revision: z.number().int().positive(), version: z.number().int().positive(), confirmed: z.literal(true) }).strict(),
]);
export function profileFromBusiness(business: Record<string, unknown>) {
  return draftProfile.parse(Object.fromEntries(Object.keys(brandInput.shape).map(key => [key, business[key]])));
}
export async function startSetup(actorId: string, raw: unknown) {
  const input = startInput.parse(raw);
  return createSetup(actorId, input, false);
}
export async function startConnectionDraft(actorId: string, raw: unknown) {
  const input = connectionDraftInput.parse(raw);
  return createSetup(actorId, { ...input, website: "", industry: "" }, true);
}
async function createSetup(actorId: string, input: z.infer<typeof startInput>, connectionOnly: boolean) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${input.organizationId} FOR UPDATE`;
    const members = await tx.$queryRaw<{role:string}[]>`SELECT role FROM "Membership" WHERE "organizationId"=${input.organizationId} AND "userId"=${actorId} FOR SHARE`;
    if (!members[0] || !["OWNER", "ADMIN"].includes(members[0].role)) throw new AppError(403, "A workspace owner or admin must start business setup.");
    const setupKey = createHash("sha256").update(JSON.stringify([input.organizationId, actorId, input.requestId])).digest("hex");
    const existing = await tx.business.findUnique({ where: { setupKey } });
    if (existing) return { id: existing.id };
    if (await tx.business.count({ where: { organizationId: input.organizationId } }) >= 3) throw new AppError(409, "This pilot supports up to three businesses per organization.");
    const business = await tx.business.create({ data: { organizationId: input.organizationId, name: input.name, website: input.website, industry: input.industry, setupKey, setupStep: 1, setupRevision: 1, contentPreferences: contentPreferences.parse({}) } });
    await tx.auditEvent.create({ data: { businessId: business.id, organizationId: input.organizationId, actorId, action: "SETUP_STARTED", detail: connectionOnly ? "Named business draft created for social connections. Brand setup, website import and content approval remain incomplete." : "Business setup saved. No website request, paid generation or publication authorized." } });
    return { id: business.id };
  });
}
export async function readSetup(scope: Scope) {
  const business = await db.business.findFirst({ where: { id: scope.businessId, organizationId: scope.organizationId } });
  const member = await db.membership.findUnique({ where: { organizationId_userId: { organizationId: scope.organizationId, userId: scope.actorId } } });
  if (!business || !member || business.setupStep === null) throw new AppError(404, "Setup not found.");
  return { profile: profileFromBusiness(business), details: setupDetails.parse(business.setupDetails), step: business.setupStep, revision: business.setupRevision, version: business.version, canEdit: ["OWNER", "ADMIN", "EDITOR"].includes(member.role) };
}
export async function manageSetup(scope: Scope, raw: unknown) {
  const input = actionInput.parse(raw);
  return db.$transaction(async tx => {
    const business = await lockBusiness(tx, scope); await assertBrandEditor(tx, scope);
    if (business.setupStep === null) throw new AppError(404, "Setup not found.");
    if (input.action === "finish" && business.setupStep === 6 && business.version === input.version) return { ok: true };
    if (business.setupRevision !== input.revision || business.version !== input.version) throw new AppError(409, "This setup changed in another tab or through brand analysis. Reload the saved setup before continuing.");
    if (business.setupStep === 6) throw new AppError(409, "Setup is complete. Edit your saved brand profile instead.");
    if (input.action === "simple-save") {
      const profile = { ...input.profile, website: requiredWebsite.parse(input.profile.website) };
      if (input.step === 5) {
        if (business.setupStep < 2) throw new AppError(409, "Choose your brand-book option first.");
        brandInput.parse(profile);
      }
      if (input.step >= 2 && input.details.brandBook === "undecided") throw new AppError(400, "Choose whether you have a brand book.");
      if (new Set(input.details.socialProfiles.map(s => s.platform)).size !== input.details.socialProfiles.length)
        throw new AppError(400, "Add one public profile per platform.");
      let socialProfiles;
      try { socialProfiles = input.details.socialProfiles.map(s => ({ ...s, url: socialAddress(s.platform, s.url) })); }
      catch { throw new AppError(400, "Check your public social profile links."); }
      if (JSON.stringify(profileFromBusiness(business)) !== JSON.stringify(profile)) await replaceBrandProfile(tx, scope, profile);
      await tx.business.update({ where: { id: business.id }, data: { setupStep: input.step, setupDetails: { ...input.details, socialProfiles }, setupRevision: { increment: 1 } } });
      await tx.auditEvent.create({ data: { ...scope, action: "SETUP_SAVED", detail: "Simple setup saved. Public profile links do not connect accounts or authorize publishing." } });
      return { ok: true };
    }
    if (input.action === "save") {
      requiredWebsite.parse(input.profile.website);
      if (input.step > business.setupStep + 1) throw new AppError(409, "Complete the preceding setup step first.");
      if (input.step >= 3) brandInput.parse(input.profile);
      const current = profileFromBusiness(business);
      if (JSON.stringify(current) !== JSON.stringify(input.profile)) await replaceBrandProfile(tx, scope, input.profile);
      await tx.business.update({ where: { id: business.id }, data: { setupStep: input.step, setupRevision: { increment: 1 } } });
      await tx.auditEvent.create({ data: { ...scope, action: "SETUP_SAVED", detail: `Saved setup step ${input.step}; no generation or publishing started.` } });
      return { ok: true };
    }
    if (business.setupStep !== 5) throw new AppError(409, "Review your setup before finishing.");
    const profile = brandInput.parse(profileFromBusiness(business));
    requiredWebsite.parse(profile.website);
    await tx.brandSnapshot.upsert({ where: { businessId_version: { businessId: business.id, version: business.version } }, create: { businessId: business.id, organizationId: business.organizationId, version: business.version, data: JSON.parse(JSON.stringify(business)) }, update: {} });
    await tx.business.update({ where: { id: business.id }, data: { confirmedAt: new Date(), setupStep: 6, setupRevision: { increment: 1 } } });
    const existing = await tx.productionPlan.findFirst({ where: { businessId: business.id, brandVersion: business.version, status: "PROPOSED" } });
    if (!existing) await tx.productionPlan.create({ data: { businessId: business.id, organizationId: business.organizationId, brandVersion: business.version, title: "Your first content direction", creditCeiling: 0, items: { create: proposePlan(profile) } } });
    await tx.auditEvent.create({ data: { ...scope, action: "SETUP_COMPLETED", detail: "Human-confirmed brand and zero-cost planning outline saved. Paid production, scheduling and publication remain separately authorized." } });
    return { ok: true };
  });
}
