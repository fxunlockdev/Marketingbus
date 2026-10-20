// Invoked by verify-browser.mjs --application with its own fresh, loopback-only DB.
// Real production services/HTTP transport; no mocks, paid AI, or existing user data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

async function main() {
  const database = new URL(process.env.DATABASE_URL ?? "");
  const scraper = new URL(process.env.FIRECRAWL_SELF_HOSTED_URL ?? "");
  assert.equal(process.env.SCRAPER_ACCEPTANCE_DATABASE, "disposable");
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.PAID_EXECUTION_ENABLED, "false");
  assert.equal(database.hostname, "127.0.0.1");
  assert.equal(database.pathname, "/scraper_acceptance");
  assert.equal(scraper.hostname, "127.0.0.1");
  const { db } = await import("../../src/lib/db");
  const { manageSource, listSources } = await import("../../src/lib/knowledge/service");
  const { runOneSourceJob } = await import("../../src/lib/knowledge/worker");
  const check = (label: string) => console.log(`PASS ${label}`);
  try {
    // Refuse an existing dataset, even if someone manually copies the fixture flags.
    assert.equal(await db.organization.count(), 0);
    assert.equal(await db.user.count(), 0);
    const a = await db.organization.create({ data: { name: "Disposable import acceptance A" } });
    const b = await db.organization.create({ data: { name: "Disposable import acceptance B" } });
    const business = await db.business.create({ data: { organizationId: a.id, name: "Website intake acceptance" } });
    const actor = await db.user.create({ data: { email: "scraper-acceptance@example.test", name: "Disposable scraper reviewer",
      passwordHash: "not-a-login", memberships: { create: { organizationId: a.id, role: "OWNER" } } } });
    const scope = { organizationId: a.id, businessId: business.id, actorId: actor.id };
    const request = { action: "website", url: "https://firecrawl-test-site.vercel.app/", rightsConfirmed: true };
    const first = await manageSource(scope, request);
    assert.ok(first.sourceId);
    assert.equal((await manageSource(scope, request)).sourceId, first.sourceId);
    assert.equal(await db.job.count({ where: { kind: "WEBSITE_READ" } }), 1);
    check("application queues and deduplicates website import");
    assert.equal(await runOneSourceJob(), true);
    const source = await db.knowledgeSource.findUniqueOrThrow({ where: { id: first.sourceId } });
    const job = await db.job.findUniqueOrThrow({ where: { key: `source:${first.sourceId}` } });
    assert.equal(job.status, "COMPLETED", `Unexpected import error: ${job.errorCode}`);
    assert.equal(job.attempts, 1);
    assert.equal(source.status, "PROPOSED");
    assert.ok(source.body.includes("Firecrawl"));
    assert.ok(source.retrievedAt);
    assert.equal(source.sha256, createHash("sha256").update(source.body).digest("hex"));
    assert.equal((job.result as { aiCalls: number }).aiCalls, 0);
    check("real worker persists actual scraped Markdown with evidence hash");
    assert.equal((await db.business.findUniqueOrThrow({ where: { id: business.id } })).proof, "");
    assert.equal((await manageSource(scope, request)).cached, true);
    assert.equal(await runOneSourceJob(), false);
    assert.equal(await db.job.count(), 1);
    check("repeat intake uses business cache without new work or automatic approval");
    assert.equal((await listSources({ businessId: business.id, organizationId: b.id })).length, 0);
    await assert.rejects(manageSource({ ...scope, organizationId: b.id }, { action: "evidence", sourceId: source.id, quote: source.body.slice(0, 100) }));
    await assert.rejects(manageSource(scope, { action: "evidence", sourceId: source.id, quote: "UNSUPPORTED CLAIM NOT FROM THE WEBSITE" }));
    const excerpt = source.body.slice(0, 100).trim();
    const evidence = await manageSource(scope, { action: "evidence", sourceId: source.id, quote: excerpt });
    assert.equal(evidence.evidence?.quote, excerpt);
    assert.equal(evidence.evidence?.sha256, source.sha256);
    check("review only selects exact evidence and denies cross-business access");
    const failed = await manageSource(scope, { ...request, url: "https://expired.badssl.com/" });
    assert.equal(await runOneSourceJob(), true);
    assert.equal(await runOneSourceJob(), false);
    const failedSource = (await listSources({ businessId: business.id, organizationId: a.id })).find(row => row.id === failed.sourceId);
    assert.equal(failedSource?.status, "FAILED");
    assert.equal(failedSource?.body, "");
    assert.ok(failedSource?.failureMessage);
    assert.equal((await db.job.findUniqueOrThrow({ where: { key: `source:${failed.sourceId}` } })).attempts, 1);
    check("real certificate failure is redacted and not automatically retried");
    const interrupted = await manageSource(scope, { ...request, url: `${request.url}interrupted` });
    await db.job.update({ where: { key: `source:${interrupted.sourceId}` }, data: { status: "RUNNING", attempts: 1, leaseUntil: new Date(Date.now() - 1000) } });
    await db.knowledgeSource.update({ where: { id: interrupted.sourceId }, data: { status: "FETCHING" } });
    assert.equal(await runOneSourceJob(), false);
    assert.equal((await db.job.findUniqueOrThrow({ where: { key: `source:${interrupted.sourceId}` } })).errorCode, "IMPORT_INTERRUPTED");
    assert.equal((await db.knowledgeSource.findUniqueOrThrow({ where: { id: interrupted.sourceId } })).status, "FAILED");
    check("expired worker lease releases the queue without silently resubmitting");
    for (const sourceId of [first.sourceId, failed.sourceId, interrupted.sourceId]) await manageSource(scope, { action: "delete", sourceId });
    assert.equal(await db.knowledgeSource.count(), 0);
    check("reviewed, failed and interrupted sources can be deleted");
  } finally {
    await db.$disconnect();
  }
}
main().catch(error => {
  // Never print connection strings, credentials or scraped website contents.
  console.error(`Application acceptance failed (${error instanceof Error ? error.name : "unknown"}).`);
  process.exitCode = 1;
});
