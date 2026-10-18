import { vi } from "vitest";
import sharp from "sharp";
import { metaFixture } from "./meta";
import { createInstagramPublishingAdapter } from "../../src/lib/social/instagram-publishing";
import { fingerprint } from "../../src/lib/social/instagram-jpeg";
import type { Account, PublicationPayload } from "../../src/lib/social/contracts";
import type { SubmissionJournal } from "../../src/lib/social/submission-journal";
import type { ImageTransferState, SocialImageTransfer } from "../../src/lib/social/image-transfer";
import type { InstagramDelivery } from "../../src/lib/social/instagram-delivery";
export async function instagramFixture(journalOverride?: SubmissionJournal, transferOverride?: SocialImageTransfer, deliveryOverride?: InstagramDelivery) {
  const f = metaFixture("Instagram"), id = "1234567", containerId = "7654321";
  const account: Account = { id: "local-instagram-connection", provider: "Instagram", externalAccountId: "987", token: "private-test-only-page-token" };
  const bytes = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#abcdef" } }).png().toBuffer();
  const payload: PublicationPayload = { channel: "Instagram", format: "static", caption: "Design consultations for your home.", mediaExportId: "local-export", image: { sha256: fingerprint(bytes), bytes: bytes.length, width: 1080, height: 1080, altText: "Considered spaces" } };
  const state: ImageTransferState = { started: false, externalId: null, uploaded: false };
  const transfer: SocialImageTransfer = transferOverride ?? {
    inspect: vi.fn(async () => ({ ...state })), read: vi.fn(async () => bytes), check: vi.fn(async () => {}),
    begin: vi.fn(async () => { if (state.started) return false; state.started = true; return true; }),
    record: vi.fn(async (_ctx, id) => { if (state.externalId) throw Error("Already recorded"); state.externalId = id; }),
    uploaded: vi.fn(async () => { state.uploaded = true; }),
  };
  let fenced = false, candidate: string | null = null;
  const journal: SubmissionJournal = journalOverride ?? { begin: vi.fn(async () => { if (fenced) return false; fenced = true; return true; }), record: vi.fn(async (_ctx, id) => { candidate = id; }), candidate: vi.fn(async () => candidate) };
  const delivery: InstagramDelivery = deliveryOverride ?? { issue: vi.fn(async () => `https://studio.marketingbus.com/api/social/media/local-publication/${"a".repeat(64)}`) };
  const ready = { id: containerId, status_code: "FINISHED" }, post = { id, owner: { id: account.externalAccountId }, caption: payload.caption, alt_text: payload.image!.altText, media_type: "IMAGE", media_product_type: "FEED", timestamp: new Date().toISOString(), permalink: "https://www.instagram.com/p/TEST_ONLY/" };
  f.replies.splice(0, f.replies.length, { data: f.inspectedPage }, f.identity, { id: containerId }, ready, { id }, post);
  return { ...f, id, containerId, account, bytes, payload, state, transfer, journal, delivery, ready, post, adapter: createInstagramPublishingAdapter(f.config, f.fetcher, journal, transfer, delivery), signal: () => AbortSignal.timeout(45000) };
}
