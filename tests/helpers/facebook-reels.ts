import { createHash } from "node:crypto";
import { vi } from "vitest";
import { facebookPublishingFixture } from "./facebook-publishing";
import { createFacebookPublishingAdapter } from "../../src/lib/social/facebook-publishing";
import type { PublicationPayload } from "../../src/lib/social/contracts";
import type { ImageTransferState, SocialImageTransfer } from "../../src/lib/social/image-transfer";
import type { SubmissionJournal } from "../../src/lib/social/submission-journal";

// Header-only transport fixture; the database suite renders a real playable MP4.
export function facebookReelFixture() {
  let fenced = false, candidate: string | null = null;
  const journal: SubmissionJournal = {
    started: vi.fn(async () => fenced),
    begin: vi.fn(async () => { if (fenced) return false; fenced = true; return true; }),
    candidate: vi.fn(async () => candidate),
    record: vi.fn(async (_ctx, id) => { if (!fenced || candidate && candidate !== id) throw Error("Changed candidate"); candidate = id; }),
  };
  const f = facebookPublishingFixture(journal), videoId = "456789";
  const bytes = Buffer.from("000000186674797069736f6d0000020069736f6d6d703432", "hex");
  const payload: PublicationPayload = { ...f.payload, format: "video", mediaExportId: "reviewed-render", video: {
    bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: 720, height: 1280, durationMs: 5000, shareToFeed: false,
  } };
  const state: ImageTransferState = { started: false, externalId: null, uploaded: false };
  const transfer: SocialImageTransfer = {
    inspect: vi.fn(async () => ({ ...state })), read: vi.fn(async () => bytes), check: vi.fn(async () => {}),
    begin: vi.fn(async () => { if (state.started) return false; state.started = true; return true; }),
    record: vi.fn(async (_ctx, id) => { if (state.externalId) throw Error("Repeated upload"); state.externalId = id; }),
    uploaded: vi.fn(async () => { state.uploaded = true; }),
  };
  const video = { id: videoId, from: { id: f.account.externalAccountId }, description: payload.caption, published: true,
    status: { video_status: "ready", publishing_phase: { status: "complete" } }, post_id: f.id };
  const post = { ...f.post, object_id: videoId };
  const uploadUrl = `https://rupload.facebook.com/video-upload/${f.config.apiVersion}/${videoId}`;
  f.replies.splice(2, 2, { video_id: videoId, upload_url: uploadUrl }, { success: true }, { success: true }, video, post);
  return { ...f, payload, bytes, state, transfer, video, post, videoId, uploadUrl,
    adapter: createFacebookPublishingAdapter(f.config, f.fetcher, journal, { enabled: false, transfer }) };
}
