import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { manageSource } from "../src/lib/knowledge/service";
import { manageBrandAnalysis, readBrandAnalyses } from "../src/lib/knowledge/analysis";
import { runOneBrandAnalysis, recoverBrandAnalysisLeases } from "../src/lib/knowledge/analysis-worker";
import { reconcileBrandAnalysis } from "../src/lib/knowledge/reconcile";
import { heartbeat } from "../src/lib/production/readiness";
import { authorizeSupplier } from "../src/lib/production/budget";
import { brandInput } from "../src/lib/brand";
import { replaceBrandProfile } from "../src/lib/knowledge/profile";
import { lockBusiness } from "../src/lib/production/service";
import * as productionService from "../src/lib/production/service";
import type { BrandAnalysis, Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { prepareSetupAutofill, readSetupAutofill } from "../src/lib/onboarding/autofill";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.TEST_DATABASE_URL && (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !["localhost", "127.0.0.1"].includes(new URL(process.env.TEST_DATABASE_URL).hostname))) throw Error("Local test DB required");
suite("evidence-grounded brand intelligence", () => {
  const orgs: string[] = [], users: string[] = [], workerId = `brand-fixture-${crypto.randomUUID()}`;
  const text = "We offer considered architecture consultations for homeowners. Our voice is calm and clear.";
  beforeEach(async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-never-network"); vi.stubEnv("PAID_EXECUTION_ENABLED", "true");
    vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "50000000"); vi.stubEnv("TOTAL_SUPPLIER_BUDGET_MICROS", "1000000000");
    vi.stubEnv("REASONING_RATE_CARD_JSON", JSON.stringify([{ provider: "openai", model: "FIXTURE", lane: "creative", inputUsdPerMillion: 2, outputUsdPerMillion: 8, verifiedUntil: "2099-01-01T00:00:00Z" }]));
    await heartbeat(workerId);
  });
  afterAll(async () => {
    const analyses = await db.brandAnalysis.findMany({ where: { organizationId: { in: orgs } }, select: { id: true } });
    await db.supplierAuthorization.deleteMany({ where: { key: { in: analyses.map(a => a.id) } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.user.deleteMany({ where: { id: { in: users } } });
    await db.workerHeartbeat.deleteMany({ where: { id: workerId } }); vi.unstubAllEnvs(); await db.$disconnect();
  });
  async function setup() {
    const user = await db.user.create({ data: { email: `brand-${crypto.randomUUID()}@example.test`, name: "Brand fixture", passwordHash: "fixture-no-login" } }); users.push(user.id);
    const org = await db.organization.create({ data: { name: "BRAND TEST", wallet: { create: { available: 1000 } }, memberships: { create: { userId: user.id, role: "OWNER" } } } }); orgs.push(org.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Fixture Studio", offering: "Design consultations", audience: "Homeowners", goal: "Book consultations", confirmedAt: new Date() } });
    const scope = { organizationId: org.id, businessId: business.id, actorId: user.id };
    const result = await manageSource(scope, { action: "document", title: "Approved website text", text, rightsConfirmed: true });
    const source = await db.knowledgeSource.findUniqueOrThrow({ where: { id: result.sourceId! } });
    const suggestions = [
      { field: "offering", kind: "EXACT_EXCERPT", value: "We offer considered architecture consultations for homeowners.", reason: "A specific description of your offering from the supplied page.", citations: [{ sourceId: source.id, sha256: source.sha256, excerpt: "We offer considered architecture consultations for homeowners." }] },
      { field: "tone", kind: "INFERRED_TONE", value: "Calm, clear and considered", reason: "An inferred writing preference from the page's stated voice.", citations: [{ sourceId: source.id, sha256: source.sha256, excerpt: "Our voice is calm and clear." }] },
    ];
    return { scope, source, suggestions, reasoner: vi.fn(async () => ({ id: "fixture-response", text: JSON.stringify({ suggestions }), usage: { input_tokens: 100, output_tokens: 100 } })) };
  }
  async function quote(f: Awaited<ReturnType<typeof setup>>) {
    const result = await manageBrandAnalysis(f.scope, { action: "quote", sourceIds: [f.source.id] });
    if (!("analysisId" in result)) throw Error("Missing quote"); return result.analysisId!;
  }
  async function accepted(f: Awaited<ReturnType<typeof setup>>) {
    const id = await quote(f); await manageBrandAnalysis(f.scope, { action: "accept", analysisId: id }); return id;
  }
  async function longSource(f: Awaited<ReturnType<typeof setup>>) {
    const body = text + "\n" + "More synthetic website details. ".repeat(2000);
    const sha256 = createHash("sha256").update(body).digest("hex");
    await db.knowledgeSource.update({ where: { id: f.source.id }, data: { body, sha256 } });
    f.source.body = body; f.source.sha256 = sha256;
    for (const s of f.suggestions) for (const c of s.citations) c.sha256 = sha256;
  }
  async function setupAutofill(f: Awaited<ReturnType<typeof setup>>) {
    await db.business.update({ where: { id: f.scope.businessId }, data: {
      setupStep: 2, setupKey: crypto.randomUUID(), setupRevision: 1, confirmedAt: null, website: "https://example.com/", offering: "", audience: "",
      setupDetails: { brandBook: "skip", socialProfiles: [], autofill: { requestId: crypto.randomUUID(), maxCredits: 20 } },
    } });
  }
  it("prepares setup once across concurrent requests and reloads without confirming or overwriting the brand", async () => {
    const f = await setup(); await setupAutofill(f);
    await Promise.all([prepareSetupAutofill(f.scope), prepareSetupAutofill(f.scope)]);
    expect(await db.brandAnalysis.count({ where: { businessId: f.scope.businessId } })).toBe(1);
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(1);
    await runOneBrandAnalysis(f.reasoner);
    expect(await prepareSetupAutofill(f.scope)).toMatchObject({ status: "READY", suggestions: f.suggestions });
    expect(await readSetupAutofill(f.scope)).toMatchObject({ status: "READY" });
    expect(await db.business.findUniqueOrThrow({ where: { id: f.scope.businessId } })).toMatchObject({ offering: "", audience: "", confirmedAt: null, version: 1 });
    await runOneBrandAnalysis(f.reasoner); expect(f.reasoner).toHaveBeenCalledTimes(1);
  });
  it("does not prepare without saved consent or for another tenant or viewer", async () => {
    const f = await setup(), other = await setup();
    await expect(prepareSetupAutofill(f.scope)).rejects.toThrow("Review my brand");
    await setupAutofill(f);
    await expect(prepareSetupAutofill({ ...f.scope, actorId: other.scope.actorId })).rejects.toThrow("not found");
    await db.membership.update({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } }, data: { role: "VIEWER" } });
    await expect(prepareSetupAutofill(f.scope)).rejects.toThrow("editing access");
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
  });
  it("delivers interpreted business drafts through onboarding without silently confirming them", async () => {
    const f = await setup(); await setupAutofill(f);
    await prepareSetupAutofill(f.scope);
    const suggestions = [
      { ...f.suggestions[0], kind: "SUMMARY_DRAFT", value: "Architecture advice to help plan a home." },
      { ...f.suggestions[0], field: "audience", kind: "INFERRED_AUDIENCE", value: "People planning changes to their homes.", reason: "A proposed customer segment based on the architecture consultation service." },
    ];
    const slots = { name: null, offering: null, audience: null, difference: null, proof: null, tone: null, restrictions: null,
      ...Object.fromEntries(suggestions.map(({ field, ...proposal }) => [field, proposal])) };
    await runOneBrandAnalysis(async () => ({ id: "fixture-draft", text: JSON.stringify(slots), usage: { input_tokens: 100, output_tokens: 100 } }));
    expect(await readSetupAutofill(f.scope)).toMatchObject({ status: "READY", suggestions });
    expect(await db.business.findUniqueOrThrow({ where: { id: f.scope.businessId } })).toMatchObject({ offering: "", audience: "", confirmedAt: null });
  });
  it("waits for a website, explains a failed import and never fabricates a result", async () => {
    const f = await setup(); await setupAutofill(f);
    await db.knowledgeSource.update({ where: { id: f.source.id }, data: { sourceUrl: "https://example.com/", status: "QUEUED" } });
    expect(await prepareSetupAutofill(f.scope)).toMatchObject({ status: "WAITING", suggestions: [] });
    await db.knowledgeSource.update({ where: { id: f.source.id }, data: { status: "FAILED" } });
    expect(await prepareSetupAutofill(f.scope)).toMatchObject({ status: "IMPORT_REQUIRED", suggestions: [] });
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
  });
  it("will not exceed the setup credit consent or hold credits after a failed transaction", async () => {
    const f = await setup(); await setupAutofill(f);
    vi.stubEnv("REASONING_RATE_CARD_JSON", JSON.stringify([{ provider: "openai", model: "FIXTURE", lane: "creative", inputUsdPerMillion: 100, outputUsdPerMillion: 100, verifiedUntil: "2099-01-01T00:00:00Z" }]));
    await heartbeat(workerId);
    await expect(prepareSetupAutofill(f.scope)).rejects.toThrow("agreed credits");
    expect(await db.brandAnalysis.count({ where: { businessId: f.scope.businessId } })).toBe(0);
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
  });
  it("waits for the requested website even if a brand book is already available", async () => {
    const f = await setup(); await setupAutofill(f);
    await db.knowledgeSource.create({ data: {
      businessId: f.scope.businessId, organizationId: f.scope.organizationId, createdBy: f.scope.actorId,
      kind: "WEBSITE", title: "Website", sourceUrl: "https://example.com/", status: "FETCHING",
    } });
    expect(await prepareSetupAutofill(f.scope)).toEqual({ status: "WAITING", suggestions: [] });
    expect(await db.brandAnalysis.count({ where: { businessId: f.scope.businessId } })).toBe(0);
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
  });
  it("includes only saved same-business public profiles in the one authorized analysis", async () => {
    const f = await setup(), other = await setup(); await setupAutofill(f);
    const url = "https://www.instagram.com/fixture";
    const business = await db.business.findUniqueOrThrow({ where: { id: f.scope.businessId } });
    await db.business.update({ where: { id: business.id }, data: {
      setupDetails: { ...(business.setupDetails as Prisma.JsonObject), socialProfiles: [{ platform: "Instagram", url }] },
    } });
    const addProfile = (scope: typeof f.scope, sourceUrl: string) => db.knowledgeSource.create({ data: {
      businessId: scope.businessId, organizationId: scope.organizationId, createdBy: scope.actorId, kind: "WEBSITE",
      title: "Public profile", sourceUrl, body: text, sha256: f.source.sha256, status: "PROPOSED", retrievedAt: new Date(),
    } });
    const selected = await addProfile(f.scope, url);
    const foreign = await addProfile(other.scope, url);
    const unselected = await addProfile(f.scope, "https://www.instagram.com/not-selected");
    await prepareSetupAutofill(f.scope);
    const row = await db.brandAnalysis.findFirstOrThrow({ where: { businessId: business.id } });
    const refs = row.sources as { id: string }[];
    expect(refs.map(ref => ref.id).sort()).toEqual([f.source.id, selected.id].sort());
    expect(refs.map(ref => ref.id)).not.toContain(foreign.id);
    expect(refs.map(ref => ref.id)).not.toContain(unselected.id);
    await prepareSetupAutofill(f.scope);
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(1);
    // Settle through the ordinary injected worker path; no public-profile or AI call.
    await runOneBrandAnalysis(f.reasoner);
    expect(await readSetupAutofill(f.scope)).toMatchObject({ status: "READY" });
  });
  it.each(["source", "profile"] as const)("does not return stale setup results after %s changes", async changed => {
    const f = await setup(); await setupAutofill(f);
    await prepareSetupAutofill(f.scope); await runOneBrandAnalysis(f.reasoner);
    if (changed === "source") await db.knowledgeSource.update({ where: { id: f.source.id }, data: { body: "Changed source text without its hash." } });
    else await db.business.update({ where: { id: f.scope.businessId }, data: { version: { increment: 1 } } });
    expect(await readSetupAutofill(f.scope)).toEqual({ status: "STALE", suggestions: [] });
    await prepareSetupAutofill(f.scope);
    expect(await db.brandAnalysis.count({ where: { businessId: f.scope.businessId } })).toBe(1);
  });
  it("does not retry ambiguous paid setup requests", async () => {
    const f = await setup(); await setupAutofill(f);
    await prepareSetupAutofill(f.scope);
    const reasoner = vi.fn(async () => { throw Error("uncertain"); });
    await runOneBrandAnalysis(reasoner);
    expect(await prepareSetupAutofill(f.scope)).toMatchObject({ status: "NEEDS_RECONCILIATION" });
    await runOneBrandAnalysis(reasoner); expect(reasoner).toHaveBeenCalledTimes(1);
  });
  it("analyzes a large imported page within the existing allowance and applies only reviewed excerpts", async () => {
    const f = await setup(); await longSource(f);
    const id = await accepted(f);
    const provider = vi.fn(async (_provider, request) => {
      const evidence = JSON.parse(request.input).untrustedSources;
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({ id: f.source.id, sha256: f.source.sha256 });
      expect(Buffer.byteLength(evidence[0].body)).toBe(24000);
      expect(f.source.body.startsWith(evidence[0].body)).toBe(true);
      return f.reasoner();
    });
    await runOneBrandAnalysis(provider);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await db.business.findUniqueOrThrow({ where: { id: f.scope.businessId } })).toMatchObject({ offering: "Design consultations", version: 1 });
    await manageBrandAnalysis(f.scope, { action: "apply", analysisId: id, fields: ["offering"], version: 1 });
    expect(await db.business.findUniqueOrThrow({ where: { id: f.scope.businessId } })).toMatchObject({ offering: f.suggestions[0].value, confirmedAt: null, version: 2 });
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } })).toMatchObject({ available: 999, held: 0 });
  });
  it("does not deliver a citation from text the model was not given", async () => {
    const f = await setup(); await longSource(f);
    const tail = "This unique claim appears only at the end of the original page.";
    const body = f.source.body + tail, sha256 = createHash("sha256").update(body).digest("hex");
    await db.knowledgeSource.update({ where: { id: f.source.id }, data: { body, sha256 } });
    f.suggestions.splice(0, f.suggestions.length, { ...f.suggestions[0], value: tail, citations: [{ sourceId: f.source.id, sha256, excerpt: tail }] });
    const id = await accepted(f);
    await runOneBrandAnalysis(f.reasoner);
    expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "FAILED", errorCode: "GROUNDING_CHECK_FAILED", supplierCostMicros: 1000 });
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } })).toMatchObject({ available: 1000, held: 0 });
  });
  it.each(["accept", "submit", "delivery", "apply"] as const)("rejects a changed unread source tail at %s", async boundary => {
    const f = await setup(); await longSource(f);
    const id = await quote(f);
    const changeTail = () => db.knowledgeSource.update({ where: { id: f.source.id }, data: { body: f.source.body + " Changed tail." } });
    if (boundary === "accept") {
      await changeTail();
      await expect(manageBrandAnalysis(f.scope, { action: "accept", analysisId: id })).rejects.toThrow("source evidence changed");
      expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
      return;
    }
    await manageBrandAnalysis(f.scope, { action: "accept", analysisId: id });
    if (boundary === "submit") await changeTail();
    await runOneBrandAnalysis(async () => {
      if (boundary === "delivery") await changeTail();
      return f.reasoner();
    });
    if (boundary === "submit") {
      expect(f.reasoner).not.toHaveBeenCalled();
      expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "FAILED", errorCode: "PREFLIGHT_FAILED" });
    } else if (boundary === "delivery") {
      expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "STALE", suggestions: null, supplierCostMicros: 1000 });
    } else {
      await changeTail();
      await expect(manageBrandAnalysis(f.scope, { action: "apply", analysisId: id, fields: ["offering"], version: 1 })).rejects.toThrow("source evidence changed");
      expect(await db.business.findUniqueOrThrow({ where: { id: f.scope.businessId } })).toMatchObject({ offering: "Design consultations", version: 1 });
    }
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } })).toMatchObject({ available: boundary === "apply" ? 999 : 1000, held: 0 });
  });
  it("refuses corrupted full-source evidence even before quoting", async () => {
    const f = await setup(); await longSource(f);
    await db.knowledgeSource.update({ where: { id: f.source.id }, data: { body: f.source.body + " Changed tail." } });
    await expect(quote(f)).rejects.toThrow("source evidence changed");
    expect(await db.brandAnalysis.count({ where: { businessId: f.scope.businessId } })).toBe(0);
  });
  it("quotes without spending, accepts concurrently once and applies selected changes without confirming", async () => {
    const f = await setup(), id = await quote(f);
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
    await Promise.all([1, 2].map(() => manageBrandAnalysis(f.scope, { action: "accept", analysisId: id })));
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(1);
    await runOneBrandAnalysis(f.reasoner); await runOneBrandAnalysis(f.reasoner); expect(f.reasoner).toHaveBeenCalledTimes(1);
    expect((await readBrandAnalyses(f.scope)).analyses[0]).toMatchObject({ status: "READY" });
    await manageBrandAnalysis(f.scope, { action: "reject", analysisId: id, field: "tone" });
    await expect(manageBrandAnalysis(f.scope, { action: "apply", analysisId: id, fields: ["tone"], version: 1 })).rejects.toThrow("unrejected");
    const apply = { action: "apply", analysisId: id, fields: ["offering"], version: 1 };
    await Promise.all([1, 2].map(() => manageBrandAnalysis(f.scope, apply)));
    const b = await db.business.findUniqueOrThrow({ where: { id: f.scope.businessId } });
    expect(b).toMatchObject({ offering: f.suggestions[0].value, version: 2, confirmedAt: null, productionEnabled: false, tone: "Clear and conversational" });
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } });
    expect(wallet).toMatchObject({ available: 999, held: 0 });
    await expect(manageBrandAnalysis(f.scope, { ...apply, fields: ["tone"] })).rejects.toThrow("different selection");
  });
  it("rejects fabricated dates and unsupported paraphrases, records supplier expense and releases customer credits", async () => {
    const f = await setup(), id = await accepted(f);
    f.suggestions.splice(1);
    f.suggestions[0].value = "Our studio launches on 25 October 2026.";
    await runOneBrandAnalysis(f.reasoner);
    expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "FAILED", supplierCostMicros: 1000, suggestions: null, errorCode: "GROUNDING_CHECK_FAILED" });
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } })).toMatchObject({ available: 1000, held: 0 });
  });
  it("delivers independently grounded fields while withholding an unsupported field without another call", async () => {
    const f = await setup(); await setupAutofill(f);
    f.suggestions[0].value = "architecture consultations";
    f.suggestions[1].value = "Award-winning since 2020";
    await prepareSetupAutofill(f.scope);
    await runOneBrandAnalysis(f.reasoner);
    expect(await readSetupAutofill(f.scope)).toMatchObject({ status: "READY", suggestions: [f.suggestions[0]] });
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } })).toMatchObject({ available: 999, held: 0 });
    expect(await db.auditEvent.findFirst({ where: { businessId: f.scope.businessId, action: "BRAND_ANALYSIS_FIELDS_WITHHELD" } }))
      .toMatchObject({ detail: "Unsupported or ambiguous fields withheld: tone. No automatic retry." });
    await prepareSetupAutofill(f.scope); await runOneBrandAnalysis(f.reasoner);
    expect(f.reasoner).toHaveBeenCalledTimes(1);
    expect(await db.business.findUniqueOrThrow({ where: { id: f.scope.businessId } })).toMatchObject({ offering: "", confirmedAt: null });
  });
  it("enforces fresh membership and tenant scope on quote, review and apply", async () => {
    const f = await setup(), other = await setup(), id = await accepted(f); await runOneBrandAnalysis(f.reasoner);
    await expect(manageBrandAnalysis(other.scope, { action: "reject", analysisId: id, field: "tone" })).rejects.toThrow("not found");
    await expect(manageBrandAnalysis(f.scope, { action: "quote", sourceIds: [other.source.id] })).rejects.toThrow("unavailable");
    await db.membership.update({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } }, data: { role: "VIEWER" } });
    expect((await readBrandAnalyses(f.scope)).canEdit).toBe(false);
    await expect(manageBrandAnalysis(f.scope, { action: "apply", analysisId: id, fields: ["offering"], version: 1 })).rejects.toThrow("editing access");
  });
  it("cancels safely before submission and never calls the provider", async () => {
    const f = await setup(), id = await accepted(f);
    await manageBrandAnalysis(f.scope, { action: "cancel", analysisId: id });
    await runOneBrandAnalysis(f.reasoner); expect(f.reasoner).not.toHaveBeenCalled();
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } })).toMatchObject({ available: 1000, held: 0 });
  });
  it("keeps ambiguous outcomes held, never retries and supports verified operator resolution", async () => {
    const f = await setup(), id = await accepted(f), timeout = vi.fn(async () => { throw Error("fixture timeout"); });
    await runOneBrandAnalysis(timeout); await runOneBrandAnalysis(timeout); expect(timeout).toHaveBeenCalledTimes(1);
    expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "NEEDS_RECONCILIATION" });
    await expect(quote(f)).rejects.toThrow("Resolve the current");
    await expect(manageBrandAnalysis(f.scope, { action: "cancel", analysisId: id })).rejects.toThrow("uncertain outcome");
    const input = { analysisId: id, supplierCostMicros: 1000, evidence: "Fixture provider log independently inspected", operatorId: "fixture-operator" };
    await reconcileBrandAnalysis(input); await reconcileBrandAnalysis(input);
    await expect(reconcileBrandAnalysis({ ...input, supplierCostMicros: 999 })).rejects.toThrow("replay changed");
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } })).toMatchObject({ available: 1000, held: 0 });
  });
  it("invalidates queued analysis and redacts proposals when a source is deleted", async () => {
    const f = await setup(), id = await accepted(f); await runOneBrandAnalysis(f.reasoner);
    const queued = await accepted(f);
    await manageSource(f.scope, { action: "delete", sourceId: f.source.id });
    expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "STALE", suggestions: null });
    expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id: queued } })).toMatchObject({ status: "STALE" });
    await runOneBrandAnalysis(f.reasoner); expect(f.reasoner).toHaveBeenCalledTimes(1);
  });
  it("discards results when the source is deleted during the provider call", async () => {
    const f = await setup(), id = await accepted(f);
    await runOneBrandAnalysis(async () => { await manageSource(f.scope, { action: "delete", sourceId: f.source.id }); return f.reasoner(); });
    expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "STALE", suggestions: null, supplierCostMicros: 1000 });
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } })).toMatchObject({ available: 1000, held: 0 });
  });
  it("manual profile changes revoke suggestions, confirmation, plans and queued holds", async () => {
    const f = await setup(), id = await accepted(f); await runOneBrandAnalysis(f.reasoner);
    const queued = await accepted(f);
    await db.productionPlan.create({ data: { businessId: f.scope.businessId, organizationId: f.scope.organizationId, brandVersion: 1, title: "Old plan", creditCeiling: 0 } });
    await db.$transaction(async tx => {
      const b = await lockBusiness(tx, f.scope);
      await replaceBrandProfile(tx, f.scope, brandInput.parse(Object.fromEntries(Object.keys(brandInput.shape).map(k => [k, b[k as keyof typeof b]]))));
    });
    for (const rowId of [id, queued]) expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id: rowId } })).toMatchObject({ status: "STALE" });
    expect(await db.productionPlan.findFirst({ where: { businessId: f.scope.businessId } })).toMatchObject({ status: "SUPERSEDED" });
    await expect(manageBrandAnalysis(f.scope, { action: "apply", analysisId: id, fields: ["offering"], version: 1 })).rejects.toThrow("no longer current");
  });
  it("fails before submission if access was revoked and releases the hold", async () => {
    const f = await setup(), id = await accepted(f);
    await db.membership.delete({ where: { organizationId_userId: { organizationId: f.scope.organizationId, userId: f.scope.actorId } } });
    await runOneBrandAnalysis(f.reasoner); expect(f.reasoner).not.toHaveBeenCalled();
    expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "FAILED", errorCode: "PREFLIGHT_FAILED" });
  });
  it("uses the shared supplier cap for brand and other production work", async () => {
    const f = await setup(), id = await accepted(f);
    vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", "1");
    await expect(db.$transaction(tx => authorizeSupplier(tx, `should-not-exist-${id}`, 1))).rejects.toThrow("supplier-spend limit");
    await manageBrandAnalysis(f.scope, { action: "cancel", analysisId: id });
  });
  it("recovers pre-submit leases but never requeues a submitted call", async () => {
    const f = await setup(), id = await accepted(f);
    await db.brandAnalysis.update({ where: { id }, data: { status: "RUNNING", leaseUntil: new Date(0) } });
    await recoverBrandAnalysisLeases(); expect((await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).status).toBe("QUEUED");
    await db.brandAnalysis.update({ where: { id }, data: { status: "SUBMITTING", submittedAt: new Date(), leaseUntil: new Date(0) } });
    await recoverBrandAnalysisLeases(); await runOneBrandAnalysis(f.reasoner); expect(f.reasoner).not.toHaveBeenCalled();
    expect((await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).status).toBe("NEEDS_RECONCILIATION");
    await reconcileBrandAnalysis({ analysisId: id, supplierCostMicros: 0, evidence: "Fixture independently confirmed no supplier expense", operatorId: "fixture-operator" });
  });
  it.each(["lease", "route", "sources", "actor", "purpose", "recovered", "recovered-error"] as const)("preserves changed %s ownership when an old brand request returns", async change => {
    const f = await setup(), id = await accepted(f);
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } });
    let retained: BrandAnalysis | undefined;
    const provider = vi.fn(async () => {
      const row = await db.brandAnalysis.findUniqueOrThrow({ where: { id } });
      if (change === "lease") await db.brandAnalysis.update({ where: { id }, data: { leaseUntil: new Date(row.leaseUntil!.getTime() + 1000) } });
      if (change === "route") await db.brandAnalysis.update({ where: { id }, data: { route: { ...(row.route as Prisma.JsonObject), credits: row.credits + 1 } } });
      if (change === "sources") await db.brandAnalysis.update({ where: { id }, data: { sources: [] } });
      if (change === "actor") await db.brandAnalysis.update({ where: { id }, data: { actorId: "replacement-author" } });
      if (change === "purpose") await db.brandAnalysis.update({ where: { id }, data: { purpose: "SKILL_REFLECTION" } });
      if (change.startsWith("recovered")) {
        await db.brandAnalysis.update({ where: { id }, data: { leaseUntil: new Date(0) } });
        await recoverBrandAnalysisLeases();
      }
      retained = await db.brandAnalysis.findUniqueOrThrow({ where: { id } });
      if (change === "recovered-error") throw Error("Synthetic late transport error");
      return f.reasoner();
    });
    await runOneBrandAnalysis(provider); await runOneBrandAnalysis(provider);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).toEqual(retained);
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } })).toEqual(wallet);
    expect(await db.auditEvent.count({ where: { businessId: f.scope.businessId, action: { in: ["BRAND_ANALYSIS_READY", "BRAND_ANALYSIS_FAILED", "BRAND_ANALYSIS_STOPPED"] } } })).toBe(0);
  });
  it.each(["before", "after"] as const)("refuses an elapsed brand claim %s submission and preserves the correct credit disposition", async boundary => {
    const f = await setup(), id = await accepted(f);
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } });
    const original = productionService.lockBusiness;
    let restoreClock = () => {};
    const expireClock = async () => {
      const row = await db.brandAnalysis.findUniqueOrThrow({ where: { id } });
      const clock = vi.spyOn(Date, "now").mockReturnValue(row.leaseUntil!.getTime() + 1);
      restoreClock = () => clock.mockRestore();
    };
    const spy = vi.spyOn(productionService, "lockBusiness").mockImplementationOnce(async (tx, scope) => {
      if (boundary === "before") await expireClock();
      return original(tx, scope);
    });
    const provider = vi.fn(async () => { await expireClock(); return f.reasoner(); });
    try { await runOneBrandAnalysis(provider); } finally { spy.mockRestore(); restoreClock(); }
    expect(provider).toHaveBeenCalledTimes(boundary === "before" ? 0 : 1);
    expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: boundary === "before" ? "FAILED" : "NEEDS_RECONCILIATION", suggestions: null, supplierCostMicros: null, leaseUntil: null });
    const after = await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } });
    if (boundary === "before") expect(after).toMatchObject({ available: 1000, held: 0 });
    else expect(after).toEqual(wallet);
  });
  it("cannot submit a changed author claim or release its hold", async () => {
    const f = await setup(), id = await accepted(f);
    const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } });
    const original = productionService.lockBusiness;
    const spy = vi.spyOn(productionService, "lockBusiness").mockImplementationOnce(async (tx, scope) => {
      await db.brandAnalysis.update({ where: { id }, data: { actorId: "replacement-author" } });
      return original(tx, scope);
    });
    try { await runOneBrandAnalysis(f.reasoner); } finally { spy.mockRestore(); }
    expect(f.reasoner).not.toHaveBeenCalled();
    expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "RUNNING", submittedAt: null, errorCode: null });
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } })).toEqual(wallet);
    await db.brandAnalysis.update({ where: { id }, data: { status: "CANCELLED", leaseUntil: null } });
  });
  it("detects source text mutation even if its stored hash was not updated", async () => {
    const f = await setup(), id = await quote(f);
    await db.knowledgeSource.update({ where: { id: f.source.id }, data: { body: "Altered source body that should not match its hash." } });
    await expect(manageBrandAnalysis(f.scope, { action: "accept", analysisId: id })).rejects.toThrow("source evidence changed");
    expect(await db.reservation.count({ where: { organizationId: f.scope.organizationId } })).toBe(0);
  });
  it("charges nothing for an empty result and rejects expired or paused quotes", async () => {
    const f = await setup(), id = await quote(f);
    await db.brandAnalysis.update({ where: { id }, data: { expiresAt: new Date(0) } });
    await expect(manageBrandAnalysis(f.scope, { action: "accept", analysisId: id })).rejects.toThrow("expired");
    vi.stubEnv("PAID_EXECUTION_ENABLED", "false");
    await expect(quote(f)).rejects.toThrow("paused");
    vi.stubEnv("PAID_EXECUTION_ENABLED", "true");
    const fresh = await accepted(f);
    await runOneBrandAnalysis(async () => ({ id: "fixture-empty", text: '{"suggestions":[]}', usage: { input_tokens: 100, output_tokens: 100 } }));
    expect(await db.brandAnalysis.findUniqueOrThrow({ where: { id: fresh } })).toMatchObject({ status: "READY", suggestions: [], supplierCostMicros: 1000 });
    expect(await db.wallet.findUniqueOrThrow({ where: { organizationId: f.scope.organizationId } })).toMatchObject({ available: 1000, held: 0 });
  });
  it("counts older unresolved work and today's detached authorizations as a union", async () => {
    const f = await setup(), id = await accepted(f), detached = `fixture-detached-${id}`;
    const row = await db.brandAnalysis.findUniqueOrThrow({ where: { id } });
    await db.brandAnalysis.update({ where: { id }, data: { acceptedAt: new Date(0) } });
    await db.supplierAuthorization.update({ where: { key: id }, data: { createdAt: new Date(0) } });
    await db.supplierAuthorization.create({ data: { key: detached, ceilingMicros: 1000000 } });
    try {
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      const todayTotal = await db.supplierAuthorization.aggregate({ where: { createdAt: { gte: today } }, _sum: { ceilingMicros: true } });
      vi.stubEnv("DAILY_SUPPLIER_BUDGET_MICROS", String((todayTotal._sum.ceilingMicros || 0) + row.supplierCeilingMicros));
      await expect(db.$transaction(tx => authorizeSupplier(tx, `blocked-${id}`, 1))).rejects.toThrow("supplier-spend limit");
    } finally {
      await db.supplierAuthorization.delete({ where: { key: detached } });
      await manageBrandAnalysis(f.scope, { action: "cancel", analysisId: id });
    }
  });
});
