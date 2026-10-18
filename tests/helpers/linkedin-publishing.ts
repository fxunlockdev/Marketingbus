import { vi } from "vitest";
import { linkedInFixture } from "./linkedin";
import { createLinkedInPublishingAdapter } from "../../src/lib/social/linkedin-publishing";
import type { Account, PublicationPayload } from "../../src/lib/social/contracts";
import type { SubmissionJournal } from "../../src/lib/social/submission-journal";
export function publishingFixture(journal?: SubmissionJournal) {
  const f = linkedInFixture(), id = "urn:li:share:456";
  const account: Account = { id: "local-connection", provider: "LinkedIn", externalAccountId: "urn:li:organization:123", token: "private-fixture-token" };
  const payload: PublicationPayload = { caption: "Considered architecture for your home.", channel: "LinkedIn", format: "static", mediaExportId: null };
  const acl = { elements: [f.entry(123)], paging: { start: 0, count: 10, links: [] } };
  const post = { id, author: account.externalAccountId, commentary: payload.caption, publishedAt: Date.now(), lifecycleState: "PUBLISHED", visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED" } };
  const stats = { elements: [{ organizationalEntity: account.externalAccountId, share: id, totalShareStatistics: { impressionCount: 100, clickCount: 4, likeCount: 2, commentCount: 3, shareCount: 1 } }] };
  let fenced = false, candidate: string | null = null;
  const memory: SubmissionJournal = { begin: vi.fn(async () => { if (fenced) return false; fenced = true; return true; }), record: vi.fn(async (_context, value) => { candidate = value; }), candidate: vi.fn(async () => candidate) };
  const activeJournal = journal ?? memory;
  f.replies.splice(0, f.replies.length, f.introspection, acl, new Response(null, { status: 201, headers: { "x-restli-id": id } }), post);
  return { ...f, id, account, payload, acl, post, stats, journal: activeJournal, adapter: createLinkedInPublishingAdapter(f.config, f.fetcher, activeJournal), signal: () => AbortSignal.timeout(45000) };
}
