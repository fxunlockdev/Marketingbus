import { vi } from "vitest";
import { metaFixture } from "./meta";
import { createFacebookPublishingAdapter } from "../../src/lib/social/facebook-publishing";
import type { Account, PublicationPayload } from "../../src/lib/social/contracts";
import type { SubmissionJournal } from "../../src/lib/social/submission-journal";
export function facebookPublishingFixture(journal?: SubmissionJournal) {
  const f = metaFixture(), id = "789_123";
  const account: Account = { id: "local-connection", provider: "Facebook", externalAccountId: "789", token: "private-fixture-page-token" };
  const payload: PublicationPayload = { caption: "Considered architecture for your home.", channel: "Facebook", format: "static", mediaExportId: null };
  const capability = { id: "789", can_post: true };
  const post = { id, from: { id: "789" }, message: payload.caption, is_published: true, is_hidden: false, created_time: new Date(Date.now() + 1000).toISOString(), permalink_url: "https://www.facebook.com/789/posts/123", application: { id: f.config.appId }, attachments: { data: [] as unknown[] } };
  let fenced = false, candidate: string | null = null;
  const memory: SubmissionJournal = { begin: vi.fn(async () => { if (fenced) return false; fenced = true; return true; }), record: vi.fn(async (_c, value) => { candidate = value; }), candidate: vi.fn(async () => candidate) };
  const activeJournal = journal ?? memory;
  f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, capability, { id }, post);
  return { ...f, id, account, payload, capability, post, journal: activeJournal, adapter: createFacebookPublishingAdapter(f.config, f.fetcher, activeJournal), signal: () => AbortSignal.timeout(45000) };
}
