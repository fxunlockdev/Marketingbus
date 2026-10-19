import { createHash } from "node:crypto";
import { vi } from "vitest";
import { publishingFixture } from "./linkedin-publishing";
import { createLinkedInPublishingAdapter } from "../../src/lib/social/linkedin-publishing";
import type { ImageTransferState, SocialImageTransfer } from "../../src/lib/social/image-transfer";

export function linkedInVideoFixture() {
  const f = publishingFixture(), videoId = "urn:li:video:C5505AQH_test", uploadUrl = "https://www.linkedin.com/dms-uploads/C5505AQH_test/uploadedVideo?sau=fixture";
  const bytes = Buffer.alloc(100000); bytes.write("ftyp", 4);
  const state: ImageTransferState = { started: false, externalId: null, uploaded: false };
  const transfer: SocialImageTransfer = {
    inspect: vi.fn(async () => ({ ...state })), read: vi.fn(async () => bytes), check: vi.fn(async () => {}),
    begin: vi.fn(async () => { if (state.started) return false; state.started = true; return true; }),
    record: vi.fn(async (_ctx, id) => { state.externalId = id; }), uploaded: vi.fn(async () => { state.uploaded = true; }),
  };
  Object.assign(f.payload, { format: "video", mediaExportId: "approved-render", video: { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, width: 720, height: 1280, durationMs: 13000, shareToFeed: false } });
  const initialized = { value: { video: videoId, uploadToken: "private-upload-token", uploadUrlsExpireAt: Date.now() + 3600000, uploadInstructions: [
    { firstByte: 0, lastByte: 49999, uploadUrl: `${uploadUrl}-part1` }, { firstByte: 50000, lastByte: 99999, uploadUrl: `${uploadUrl}-part2` },
  ] } };
  const video = { id: videoId, owner: f.account.externalAccountId, status: "AVAILABLE", duration: 13000, aspectRatioWidth: 9, aspectRatioHeight: 16 };
  const post = { ...f.post, content: { media: { id: videoId } } };
  const uploadReply = (part = 1) => new Response(null, { status: 200, headers: { etag: `"part-${part}"` } });
  f.replies.splice(0, f.replies.length, f.introspection, f.acl, initialized, uploadReply(1), uploadReply(2), new Response(null, { status: 200 }), video, new Response(null, { status: 201, headers: { "x-restli-id": f.id } }), post);
  return { ...f, post, videoId, bytes, state, transfer, video, initialized, uploadUrl, uploadReply, adapter: createLinkedInPublishingAdapter(f.config, f.fetcher, f.journal, { enabled: false, transfer }) };
}
