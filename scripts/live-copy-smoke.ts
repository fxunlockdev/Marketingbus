/** Explicit, non-repeating live OpenAI test. Never run as an automatic test or deploy hook. */
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

const marker = "live-openai-palm-clay-20261014";
const report: Record<string, unknown> = { marker, environment: "local isolated database; real OpenAI", checks: [] };
const checks = report.checks as string[];
let calls = 0;
let businessId: string | undefined;
let authorizedMicros = 0;
async function main() {
  assert.equal(process.env.CONFIRM_LIVE_SMOKE, marker, "Explicit paid-test confirmation required");
  const url = new URL(process.env.DATABASE_URL || "");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "55438");
  assert.equal(url.pathname, "/marketingbus_live_smoke_20261014");
  assert.ok(process.env.OPENAI_API_KEY);
  const resume = process.env.RESUME_LIVE_SMOKE === `${marker}:revision-only`;
  assert.equal(await db.user.count(), resume ? 1 : 0, "This one-shot test must not be rerun without explicit scoped resumption");
  process.env.PAID_EXECUTION_ENABLED = "true";
  process.env.DAILY_SUPPLIER_BUDGET_MICROS = "350000";
  process.env.TOTAL_SUPPLIER_BUDGET_MICROS = "350000";
  delete process.env.ANTHROPIC_API_KEY;
  process.env.REASONING_RATE_CARD_JSON = JSON.stringify([
    { provider: "openai", model: "gpt-4.1-2025-04-14", lane: "creative", inputUsdPerMillion: 2, outputUsdPerMillion: 8, verifiedUntil: "2026-10-21T00:00:00Z" },
    { provider: "openai", model: "gpt-4.1-mini-2025-04-14", lane: "routine", inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6, verifiedUntil: "2026-10-21T00:00:00Z" },
  ]);
  const brand = brandInput.parse({ name: "Palm & Clay — Fictional Test", industry: "Beginner pottery workshops in Dubai",
    offering: "Small-group pottery sessions for adults who want to make a useful bowl or cup. Customers can attend alone; instruction, clay and tools are included. This is a fictional test business, not an actual venue.",
    audience: "Dubai residents with screen-heavy working days who want a hands-on weekend activity without needing an existing friend group or artistic experience.",
    goal: "Encourage first-time attendees to ask about the next beginner workshop.",
    difference: "A welcoming first session focused on making something useful, not producing a perfect object. Solo beginners are explicitly welcome.",
    proof: "", tone: "Warm, observant, understated. Specific everyday details; no motivational slogans.",
    restrictions: "No invented prices, dates, venue address, class sizes, reviews, awards, medical or therapeutic claims. No scarcity, promises or performance statistics. Do not claim to be an actual operating business.",
    color: "#A45A3C", designPreset: "editorial", channels: ["Instagram", "LinkedIn", "Facebook", "X"] });
  const user = resume ? await db.user.findUniqueOrThrow({ where: { email: `${marker}@example.invalid` } }) : await db.user.create({ data: { email: `${marker}@example.invalid`, name: "Fictional live test", passwordHash: `disabled-${randomBytes(32).toString("hex")}` } });
  const org = resume ? await db.organization.findFirstOrThrow({ where: { name: marker, memberships: { some: { userId: user.id } } } }) : await db.organization.create({ data: { name: marker, memberships: { create: { userId: user.id, role: "OWNER" } }, wallet: { create: { available: 25, entries: { create: { key: `${marker}:grant`, kind: "TEST_GRANT", amount: 25 } } } } } });
  const business = resume ? await db.business.findFirstOrThrow({ where: { organizationId: org.id, name: brand.name } }) : await db.business.create({ data: { organizationId: org.id, ...brand, confirmedAt: new Date() } });
  businessId = business.id;
  if (!resume) await db.brandSnapshot.create({ data: { businessId, organizationId: org.id, version: 1, data: brand } });
  const plan = resume ? await db.productionPlan.findFirstOrThrow({ where: { businessId }, include: { items: true } }) : await db.productionPlan.create({ data: { businessId, organizationId: org.id, brandVersion: 1, title: "Fictional first campaign", creditCeiling: 0, items: { create: proposePlan(brand) } }, include: { items: true } });
  const item = plan.items.find(i => i.channel === "Instagram")!;
  const scope = { businessId, organizationId: org.id, actorId: user.id };
  if (resume) {
    const jobs = await db.job.findMany({ where: { businessId }, include: { quote: true } });
    assert.equal(jobs.length, 1, "Resume only the unsubmitted second request");
    assert.equal(jobs[0].status, "COMPLETED");
    assert.equal(jobs[0].quote?.mode, "initial");
    calls = 1;
    authorizedMicros = jobs[0].quote!.supplierCeilingMicros;
    checks.push("Initial call previously completed; resuming only the never-submitted copy revision after a conservative budget-guard stop");
  }
  const paid = async (mode: "initial" | "copy", direction: string) => {
    assert.ok(calls < 2, "At most two paid calls");
    await heartbeat(marker);
    const offered = await actOnProduction(scope, { action: "quote", itemId: item.id, mode, direction });
    assert.ok("quote" in offered && offered.quote);
    const quote = await db.generationQuote.findUniqueOrThrow({ where: { id: offered.quote.id } });
    assert.ok(authorizedMicros + quote.supplierCeilingMicros <= 350000, "Combined test authorization cannot exceed $0.35");
    const req = requestSchema.parse(quote.request);
    assert.equal(req.route.model.provider, "openai");
    if (mode === "copy") {
      assert.equal(req.route.model.model, "gpt-4.1-mini-2025-04-14");
      assert.ok(req.input.includes("solo beginners"), "Saved feedback is present in the compiled revision context");
    }
    const accepted = await actOnProduction(scope, { action: "accept", quoteId: quote.id });
    assert.ok("jobId" in accepted && accepted.jobId);
    authorizedMicros += quote.supplierCeilingMicros;
    const replay = await actOnProduction(scope, { action: "accept", quoteId: quote.id });
    assert.deepEqual(replay, accepted);
    await runOneJob(async (provider, input, key) => {
      assert.equal(provider, "openai");
      assert.ok(++calls <= 2);
      console.info(JSON.stringify({ phase: mode, model: input.model, authorizedUsd: quote.supplierCeilingMicros / 1e6 }));
      return reason(provider, input, key);
    });
    const job = await db.job.findUniqueOrThrow({ where: { id: accepted.jobId } });
    assert.equal(job.status, "COMPLETED", `Stopped without retry: ${job.errorCode || job.status}`);
    checks.push(`${mode}: real OpenAI response validated, delivered and credits settled; duplicate acceptance did not enqueue twice`);
    return db.creativeRevision.findFirstOrThrow({ where: { itemId: item.id }, orderBy: { version: "desc" } });
  };
  const first = resume ? await db.creativeRevision.findFirstOrThrow({ where: { itemId: item.id, version: 1, status: "CHANGES_REQUESTED" } }) : await paid("initial", "Build one quiet, distinctive Instagram concept around swapping a scrolling thumb for clay-covered hands. Make attending alone feel ordinary. No manufactured testimonials or urgency.");
  if (!resume) await actOnProduction(scope, { action: "revise", itemId: item.id, version: first.version, feedback: "Make it shorter, welcome solo beginners in the opening, and avoid hashtags. Keep the hands-versus-screen visual idea.", remember: true });
  assert.equal(await db.memory.count({ where: { businessId } }), 1);
  const second = await paid("copy", "Shorten the caption and lead with welcoming solo beginners. Preserve the approved visual idea; no hashtags.");
  const a = creativeSchema.parse(first.content), b = creativeSchema.parse(second.content);
  assert.equal(a.visualDirection, b.visualDirection);
  assert.equal(a.rationale, b.rationale);
  assert.ok(b.caption.length < a.caption.length, "The requested shorter revision should be shorter");
  checks.push("Feedback persisted and re-injected; cheaper copy model preserved visual direction and shortened the caption");
  await actOnProduction(scope, { action: "approve", itemId: item.id, version: second.version });
  await actOnProduction(scope, { action: "schedule", itemId: item.id, version: second.version, scheduledFor: new Date(Date.now() + 86400000).toISOString(), timezone: "Asia/Dubai" });
  assert.equal(await db.calendarEntry.count({ where: { itemId: item.id, revisionId: second.id } }), 1);
  checks.push("Approval and internal calendar reservation reference the exact revision; no social publishing");
  await actOnProduction(scope, { action: "edit", itemId: item.id, version: second.version, headline: b.headline, caption: b.caption, cta: "Ask about beginner sessions" });
  assert.equal(await db.calendarEntry.count({ where: { itemId: item.id } }), 0);
  const edited = await db.creativeRevision.findFirstOrThrow({ where: { itemId: item.id }, orderBy: { version: "desc" } });
  assert.equal(edited.status, "READY");
  await actOnProduction(scope, { action: "reject", itemId: item.id, version: edited.version, feedback: "Test rejection; no further regeneration authorized." });
  assert.equal(calls, 2);
  const wallet = await db.wallet.findUniqueOrThrow({ where: { organizationId: org.id } });
  assert.equal(wallet.held, 0);
  checks.push("Free manual edit revoked earlier approval/calendar; rejection made no provider call; no credits remain held");
  report.status = "passed";
  report.business = brand;
  report.initial = first.content;
  report.revised = second.content;
  report.wallet = { initialTestCredits: 25, available: wallet.available, held: wallet.held };
}
void main().catch(error => {
  report.status = "failed";
  report.error = error instanceof assert.AssertionError ? error.message : "Test stopped; inspect scoped job state. No automatic retry.";
  process.exitCode = 1;
}).finally(async () => {
  report.paidCallsAttempted = calls;
  report.authorizedUsd = authorizedMicros / 1e6;
  if (businessId) {
    const jobs = await db.job.findMany({ where: { businessId }, select: { id: true, status: true, errorCode: true, result: true, quote: { select: { request: true } } } });
    report.jobs = jobs.map(({ quote, ...job }) => ({ ...job, model: quote ? requestSchema.parse(quote.request).route.model.model : null }));
    await db.workerHeartbeat.deleteMany({ where: { id: marker } });
  }
  const path = resolve("../outputs/live-openai-palm-clay-20261014.json");
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.info(JSON.stringify({ status: report.status, paidCallsAttempted: calls, authorizedUsd: report.authorizedUsd, report: path }));
  await db.$disconnect();
});
