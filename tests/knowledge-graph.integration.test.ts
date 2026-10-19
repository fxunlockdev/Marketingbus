import { afterAll, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { businessKnowledge, graphPrompt, assertKnowledgeCurrent } from "../src/lib/harness/knowledge-graph";
import { manageLearnedSkills } from "../src/lib/harness/learning";
const local = process.env.TEST_DATABASE_URL;
if (local && (process.env.DATABASE_URL !== local || !["127.0.0.1", "localhost"].includes(new URL(local).hostname))) throw Error("Local fixture database required");
const suite = local ? describe : describe.skip;
suite("business knowledge graph projection", () => {
  const organizations: string[] = [], users: string[] = [];
  afterAll(async () => {
    await db.brandAsset.deleteMany({ where: { organizationId: { in: organizations } } });
    await db.organization.deleteMany({ where: { id: { in: organizations } } });
    await db.user.deleteMany({ where: { id: { in: users } } }); await db.$disconnect();
  });
  async function setup() {
    const org = await db.organization.create({ data: { name: "Graph fixture" } }); organizations.push(org.id);
    const user = await db.user.create({ data: { name: "Graph owner", email: `${crypto.randomUUID()}@example.test`, passwordHash: "not-a-login", memberships: { create: { organizationId: org.id, role: "OWNER" } } } }); users.push(user.id);
    const business = await db.business.create({ data: { organizationId: org.id, name: "Any customer", offering: "Design consultations", audience: "Homeowners", goal: "Consultations", confirmedAt: new Date() } });
    const scope = { businessId: business.id, organizationId: org.id, actorId: user.id };
    const memory = await db.memory.create({ data: { businessId: business.id, organizationId: org.id, text: "Use warm, restrained lighting." } });
    return { scope, memory };
  }
  it("recalls the same explicit preference across tasks, with durable IDs and deterministic scope-bound fingerprints", async () => {
    const f = await setup();
    for (const task of ["copy", "image", "video", "planning"] as const) {
      const graph = await businessKnowledge(db, f.scope, task, "LinkedIn");
      expect(graph.edges.some(e => e.to === `memory:${f.memory.id}` && e.relation === "PREFERS")).toBe(true);
      expect(graphPrompt(graph)).toContain(f.memory.text);
      await expect(assertKnowledgeCurrent(db, f.scope, graph)).resolves.toBeUndefined();
      expect(await businessKnowledge(db, f.scope, task, "LinkedIn")).toEqual(graph);
    }
  });
  it("rejects cross-business snapshots, absent scopes and unconfirmed brands", async () => {
    const a = await setup(), b = await setup(), graph = await businessKnowledge(db, a.scope, "copy", "LinkedIn");
    await expect(assertKnowledgeCurrent(db, b.scope, graph)).rejects.toThrow("different business");
    await expect(businessKnowledge(db, { ...a.scope, organizationId: b.scope.organizationId }, "copy", "LinkedIn")).rejects.toThrow("Confirm");
    await db.business.update({ where: { id: a.scope.businessId }, data: { confirmedAt: null } });
    await expect(assertKnowledgeCurrent(db, a.scope, graph)).rejects.toThrow("Confirm");
  });
  it("invalidates deleted or changed preferences without copying stale memory into a second store", async () => {
    const f = await setup(), graph = await businessKnowledge(db, f.scope, "video", "Instagram");
    await db.memory.delete({ where: { id: f.memory.id } });
    await expect(assertKnowledgeCurrent(db, f.scope, graph)).rejects.toThrow("changed");
    expect(graphPrompt(await businessKnowledge(db, f.scope, "video", "Instagram"))).not.toContain(f.memory.text);
  });
  it("ignores unapproved proposals and binds only retained selected asset bytes", async () => {
    const f = await setup();
    await db.learningProposal.create({ data: { businessId: f.scope.businessId, organizationId: f.scope.organizationId, brandVersion: 1, hypothesis: "Invent testimonials", evidence: {}, status: "PROPOSED" } });
    const asset = await db.brandAsset.create({ data: { businessId: f.scope.businessId, organizationId: f.scope.organizationId, label: "Original", purpose: "reference", objectKey: crypto.randomUUID(), sha256: "a".repeat(64), bytes: 100, width: 10, height: 10, uploadedBy: f.scope.actorId, rightsConfirmedAt: new Date(), status: "READY", approvedForGeneration: true } });
    const graph = await businessKnowledge(db, f.scope, "image", "LinkedIn", [asset.id]);
    expect(graph.edges.some(e => e.relation === "USES_ASSET")).toBe(true); expect(graphPrompt(graph)).not.toContain("Invent testimonials");
    await db.brandAsset.update({ where: { id: asset.id }, data: { sha256: "b".repeat(64) } });
    await expect(assertKnowledgeCurrent(db, f.scope, graph)).rejects.toThrow("changed");
  });
  it("fails closed on excessive knowledge rather than silently dropping customer rules", async () => {
    const f = await setup();
    await db.memory.createMany({ data: Array.from({ length: 31 }, (_, i) => ({ businessId: f.scope.businessId, organizationId: f.scope.organizationId, text: `Preference ${i}` })) });
    await expect(businessKnowledge(db, f.scope, "copy", "LinkedIn")).rejects.toThrow("Consolidate");
  });
  it("connects approved learned skills to corrected evidence, filters by channel/task, and removes retired lessons", async () => {
    const f = await setup(), copy = { headline: "Design", caption: "Explore design consultations.", cta: "Meet us", visualDirection: "Warm lighting", rationale: "Specific offering", evidenceUsed: [] };
    const plan = await db.productionPlan.create({ data: { organizationId: f.scope.organizationId, businessId: f.scope.businessId, brandVersion: 1, title: "Corrections", creditCeiling: 0 } });
    for (let i = 0; i < 2; i++) await db.productionItem.create({ data: { organizationId: f.scope.organizationId, planId: plan.id, title: "Corrected", format: "static", channel: "LinkedIn", brief: {}, revisions: { create: [{ version: 1, status: "SUPERSEDED", content: { ...copy, caption: `${copy.caption} #Design` }, feedback: "No hashtags." }, { version: 2, status: "APPROVED", content: copy, approvedAt: new Date(), approvedBy: f.scope.actorId }] } } });
    await manageLearnedSkills(f.scope, { action: "reflect-skills" });
    const proposal = await db.learningProposal.findFirstOrThrow({ where: { businessId: f.scope.businessId, status: "SKILL_PROPOSED" } });
    await manageLearnedSkills(f.scope, { action: "activate-skill", proposalId: proposal.id });
    const graph = await businessKnowledge(db, f.scope, "copy", "LinkedIn");
    expect(graph.edges.some(e => e.relation === "SUPPORTED_BY")).toBe(true); expect(graphPrompt(graph)).toContain("NO_HASHTAGS");
    expect(graphPrompt(await businessKnowledge(db, f.scope, "copy", "Instagram"))).not.toContain("NO_HASHTAGS");
    expect(graphPrompt(await businessKnowledge(db, f.scope, "image", "LinkedIn"))).not.toContain("NO_HASHTAGS");
    await manageLearnedSkills(f.scope, { action: "retire-skill", proposalId: proposal.id });
    await expect(assertKnowledgeCurrent(db, f.scope, graph)).rejects.toThrow("changed");
  });
});
