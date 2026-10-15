/** Owner-authorized, one-shot OpenAI regression. Never run automatically or from deployment hooks. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { db } from "../src/lib/db";
import { brandInput, proposePlan } from "../src/lib/brand";
import { actOnProduction, requestSchema } from "../src/lib/production/service";
import { heartbeat } from "../src/lib/production/readiness";
import { runOneJob } from "../src/lib/production/worker";
import { reason } from "../src/lib/providers/reasoning";
import { creativeSchema } from "../src/lib/production/content";
import { approvedFactText, evaluateCreative } from "../src/lib/production/quality";
const marker = "live-grounding-20261014";
const report: Record<string, unknown> = { marker, environment: "isolated local database; real OpenAI; no email/social calls", checks: [] };
let calls = 0, authorized = 0, businessId: string | undefined;
async function main() {
  assert.equal(process.env.CONFIRM_LIVE_GROUNDING, marker);
  const url = new URL(process.env.DATABASE_URL || "");
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55438"); assert.equal(url.pathname, "/marketingbus_grounding_20261014");
  assert.equal(await db.user.count(), 0, "One-shot test already used; never repeat paid requests automatically.");
  assert.ok(process.env.OPENAI_API_KEY); delete process.env.ANTHROPIC_API_KEY;
  process.env.PAID_EXECUTION_ENABLED = "true"; process.env.DAILY_SUPPLIER_BUDGET_MICROS = "150000"; process.env.TOTAL_SUPPLIER_BUDGET_MICROS = "150000";
  // Copy verified operator configuration, never a synthetic test price or a silently substituted model.
  const rateCard = JSON.parse(process.env.REASONING_RATE_CARD_JSON || "[]");
  assert.ok(rateCard.length === 2 && rateCard.every((m: { provider: string }) => m.provider === "openai"));
  const brand = brandInput.parse({ name: "Palm & Clay — Fictional Regression", offering: "Small-group pottery sessions for adults. Customers can attend alone; instruction, clay and tools are included. This is a fictional test business, not an actual venue.", audience: "Dubai residents with screen-heavy working days who want a hands-on activity without needing an existing friend group or artistic experience.", goal: "Encourage first-time attendees to ask about the next beginner workshop.", difference: "A welcoming first session focused on making something useful, not producing a perfect object. Solo beginners are explicitly welcome.", proof: "", tone: "Warm, observant, understated. Specific everyday details; no motivational slogans.", restrictions: "No invented prices, dates, venue address, class sizes, reviews, awards, medical or therapeutic claims. No scarcity, promises or performance statistics. Do not claim to be an actual operating business.", color: "#A45A3C", designPreset: "editorial", channels: ["Instagram"] });
  const user = await db.user.create({ data: { email: `${marker}@example.invalid`, name: "Fictional regression", passwordHash: `disabled-${randomBytes(32).toString("hex")}` } });
  const org = await db.organization.create({ data: { name: marker, memberships: { create: { userId: user.id, role: "OWNER" } }, wallet: { create: { available: 20, entries: { create: { key: `${marker}:grant`, kind: "TEST_GRANT", amount: 20 } } } } } });
  const business = await db.business.create({ data: { ...brand, organizationId: org.id, confirmedAt: new Date() } }); businessId = business.id;
  await db.brandSnapshot.create({ data: { businessId, organizationId: org.id, version: 1, data: brand } });
  const plan = await db.productionPlan.create({ data: { businessId, organizationId: org.id, brandVersion: 1, title: marker, creditCeiling: 0, items: { create: proposePlan(brand) } }, include: { items: true } });
  const item = plan.items.find(i => i.channel === "Instagram")!;
  const scope = { businessId, organizationId: org.id, actorId: user.id };
  async function paid(mode: "initial" | "copy", direction: string) {
    assert.ok(calls < 2); await heartbeat(marker);
    const offered = await actOnProduction(scope, { action: "quote", itemId: item.id, mode, direction }); assert.ok("quote" in offered && offered.quote);
    const quote = await db.generationQuote.findUniqueOrThrow({ where: { id: offered.quote.id } });
    assert.ok(authorized + quote.supplierCeilingMicros <= 150000, "Stop before exceeding the $0.15 combined authorization.");
    const req = requestSchema.parse(quote.request); assert.equal(req.route.model.provider, "openai");
    const accepted = await actOnProduction(scope, { action: "accept", quoteId: quote.id }); assert.ok("jobId" in accepted && accepted.jobId);
    authorized += quote.supplierCeilingMicros;
    assert.deepEqual(await actOnProduction(scope, { action: "accept", quoteId: quote.id }), accepted);
    await runOneJob(async (provider, input, key) => { assert.equal(provider, "openai"); assert.ok(++calls <= 2); return reason(provider, input, key); });
    const job = await db.job.findUniqueOrThrow({ where: { id: accepted.jobId } });
    assert.equal(job.status, "COMPLETED", `No retry authorized: ${job.errorCode || job.status}`);
    return db.creativeRevision.findFirstOrThrow({ where: { itemId: item.id }, orderBy: { version: "desc" } });
  }
  const first = await paid("initial", "Build one quiet, distinctive Instagram concept around swapping a scrolling thumb for clay-covered hands. Make attending alone feel ordinary. No manufactured testimonials or urgency.");
  const feedback = 'Make the caption shorter. Start the caption with "Solo beginners". No hashtags. Keep the hands-versus-screen visual idea.';
  await actOnProduction(scope, { action: "revise", itemId: item.id, version: first.version, feedback, remember: true });
  const second = await paid("copy", feedback);
  const a = creativeSchema.parse(first.content), b = creativeSchema.parse(second.content);
  assert.equal(a.visualDirection, b.visualDirection);
  const quality = evaluateCreative(b, { facts: approvedFactText(brand), previous: a, feedback }); assert.ok(quality.eligible);
  assert.ok(b.caption.startsWith("Solo beginners")); assert.ok(b.caption.length < a.caption.length);
  // Test result stays unapproved and unscheduled; mechanical eligibility is not agency-quality acceptance.
  await actOnProduction(scope, { action: "reject", itemId: item.id, version: second.version, feedback: "Regression test complete. No publishing or further calls authorized." });
  assert.equal(await db.calendarEntry.count({ where: { organizationId: org.id } }), 0);
  assert.equal((await db.wallet.findUniqueOrThrow({ where: { organizationId: org.id } })).held, 0);
  Object.assign(report, { status: "passed", initial: a, revised: b, quality, checks: ["real initial and lower-cost revision", "no invented weekday/number detected by lexical guard", "exact requested opening", "shorter caption", "no hashtags", "visual direction retained", "idempotent acceptance", "credits settled", "final version rejected and unscheduled"] });
}
void main().catch(error => { report.status = "failed"; report.error = error instanceof assert.AssertionError ? error.message : "Stopped safely; inspect job state. No automatic retry."; process.exitCode = 1; }).finally(async () => {
  if (businessId) {
    const jobs = await db.job.findMany({ where: { businessId }, select: { status: true, errorCode: true, result: true, quote: { select: { request: true } } } });
    report.jobs = jobs.map(({ quote, ...job }) => ({ ...job, model: quote ? requestSchema.parse(quote.request).route.model.model : null }));
  }
  await db.workerHeartbeat.deleteMany({ where: { id: marker } });
  report.calls = calls; report.authorizedUsd = authorized / 1e6;
  await writeFile(resolve("../outputs/live-grounding-20261014.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.info(JSON.stringify({ status: report.status, calls, authorizedUsd: report.authorizedUsd }));
  await db.$disconnect();
});
