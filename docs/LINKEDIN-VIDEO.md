# LinkedIn approved video publishing

Runtime `studio-v49-linkedin-video`, migration 55. This extends company-page publishing, not personal accounts, ads, carousels or an unrestricted uploader. It does not activate the integration or establish live acceptance.

## Customer workflow

Create the video in Asset studio, review each scene and approve the exact final render. In Publishing & analytics, select its approved creative, choose **Approved video**, pick a retained export and destination company, and schedule. Portrait, square, feed and landscape layouts are supported within the existing renderer's 3–30 second / 20 MiB ceiling. LinkedIn additionally requires at least 75 KiB. Initial exports outside this profile are not silently converted. Approval, source-asset permission, brand version, copy version and retention are rechecked before transfer and publication. Editing approved source work invalidates queued work. A published remote copy is not deleted by local edits.

## Transfer and failure behavior

Private hash-verified MP4 bytes pass through the existing leased worker, with no public bucket or customer-supplied fetch URL. Registration is durably fenced before `videos?action=initializeUpload`. All returned byte ranges must be contiguous, ordered, complete, bounded to five parts of at most 4 MiB, and reference the exact returned video at the HTTPS `www.linkedin.com/dms-uploads/<id>/uploadedVideo` path. All URLs are checked before any part is sent. Redirects, other hosts/ports, credentials and fragments are rejected. OAuth credentials are never sent with signed binary-upload requests.

Each part must return HTTP 200 and a bounded unique ETag; ordered ETags and the opaque upload token finalize the video. Upload URLs, token and ETags remain in memory, never database/audit/customer responses. No provider response bodies are logged. Approval is rechecked between parts. A lost registration, part or finalization acknowledgement holds the attempt without repeating a write. The operator can preview and explicitly close an inactive **pre-post** attempt using the existing scoped recovery tool; this leaves any remote unused media alone. It cannot close an uncertain post-submission attempt.

After acknowledged finalization, only the exact video ID is polled. Owner, ID, availability, aspect ratio and duration must match (100 ms duration tolerance and 0.01 ratio tolerance for provider metadata rounding). Processing allows up to 15 total worker attempts, at least one minute apart, with no repeated registration/upload/finalization. Processing exhaustion holds for review. An expired grant, disabled gate or changed approval stops work.

A separate durable post fence precedes `POST /rest/posts`. Only a returned post ID plus exact author, commentary, media ID and public main-feed published read-back establishes success. Lost read-back is recoverable through that exact candidate; a lost candidate never causes caption searching or reposting.

## Analytics and controls

Organic post impressions, reach, clicks and like/comment/share totals use the existing exact-company, exact-post statistics adapter. Read-back before and after metrics invalidates externally changed media/copy/distribution. Video views remain null; post impressions are not video plays, and no video-completion claim is made. Existing evidence/cohort safeguards still govern learning.

Requires existing LinkedIn connection/publishing configuration plus `LINKEDIN_VIDEO_PUBLISHING_ENABLED=true` on matching web and worker releases. Leave disabled until designated-account OAuth, approved test-post permission, actual upload/processing/read-back, metrics and failure/recovery checks pass. No new paid AI call is required for transport testing with an existing approved export. The feature adds no services, storage tier or higher concurrency/quotas. Metadata fixtures and local playable-video tests are not live-provider acceptance.

Sources checked 19 October 2026: [Videos API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-07) and [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-07). Provider limits can exceed this product's current approved-render envelope. Separate caption-file/thumbnail upload and dedicated video-view metrics are not implemented here; existing burned-in composition text and approved audio are transferred unchanged.
