# LinkedIn company text publishing and post metrics

This release implements the HTTP transport behind the existing approval/scheduling/worker workflow. It supports organic **text-only company posts** for approved administrators. It does not upload images/video, publish personal-profile posts, enable Facebook/Instagram publishing, or establish live platform acceptance.

## Configuration

Keep both `LINKEDIN_PUBLISHING_ENABLED=false` and `SOCIAL_EXECUTION_ENABLED=false` until designated-account acceptance. Configure the existing LinkedIn credentials, supported version and verification expiry on **web and worker**. `LINKEDIN_CONNECTIONS_ENABLED` is also required to register the publisher. `SOCIAL_DATA_ENABLED` independently controls explicit account/profile reads; it is not a substitute for the per-post worker. See [activation checklist](ACTIVATION-CHECKLIST.md).

The adapter rejects unsupported account/provider/channel/format/media before HTTP. It rechecks application-bound token introspection, expiry, required scopes and approved company administration before submission, reconciliation and metrics. Role discovery is bounded to two pages of ten; it does not follow response URLs. All reads use fixed HTTPS endpoints, reject redirects, bound received bytes and time out. Errors never disclose raw responses or secrets.

## Submission and read-back

The existing schedule freezes the exact approved caption and brand version. Immediately before the remote write, `submission-journal.ts` locks the business and verifies the persisted payload, account, current encrypted credential and active submission lease, then records `submissionAdapterVersion`. This durable local fence permits only one POST attempt. It is **not** a claim that LinkedIn supports idempotency keys.

The adapter uses `POST /rest/posts` with organic public/main-feed text parameters. Only HTTP 201 with a valid `x-restli-id` is a candidate. It persists `candidatePostId` before `GET /rest/posts/{id}?viewContext=READER` and verifies exact ID, author, published status, timestamp, caption and absence of media/reshare/ad context. Only a verified receipt sets `externalPostId` and `PUBLISHED`. No permalink is invented.

Before any write, temporary rate/server failures may safely retry through the existing bounded worker policy. After the durable fence, **any** unknown response or failure remains uncertain; it does not resend. Known candidate IDs may be read back with the existing five-attempt reconciliation policy. A lost submission response with no candidate ID stays held for operator investigation. Empty search results or caption matching are not proof that no post exists. No customer endpoint accepts a fabricated receipt.

Migration `20261018040000_social_submission_journal` is additive. It adds the version/candidate fields, bounded-value checks and uniqueness of `(connectionId, candidatePostId)`. Do not drop those fields to retry a post. Interrupted publication state and candidate IDs are included in the synthetic restoration rehearsal.

## Metrics and learning boundary

For a verified app publication, the worker rechecks token/admin ownership and the exact published post, then requests organic share/UGC-post statistics for that company and ID. Company-wide aggregates are rejected as per-post observations. Lifetime snapshots are never added together. Missing values remain null. Engagements means likes + comments + shares, excluding clicks; the API version and definition are stored with each snapshot. Negative organic-like adjustments are accepted as a platform possibility, but prevent deriving a misleading nonnegative engagement total. Valid other metrics remain available.

Credential, account, post or payload changes during a request prevent snapshot persistence. Expiry/disconnection stops ingestion. Existing periodic collection, five-failure bounds and human-reviewed observational learning policies still apply. This release supplies per-publication evidence; text-only production does **not** by itself produce the two-format experiment cohorts required by the current learning evaluator. It is not evidence of causal or creative improvement.

The share-statistics documentation names `rw_organization_admin`, whereas the organization-role documentation also describes reporting under `r_organization_admin`. The application currently requests the latter plus organization social read/write. Verify the actual app's approved reporting access; denied reporting remains unavailable and must not be relabelled as successful analytics. A necessary scope expansion requires a reviewed code/configuration update and reconnection.

## Verification

Tests exercise the real transport with injected HTTP: valid submission/read-back, preflight denial, revoked/expired/foreign app grants, wrong accounts/captions, malformed replies, unknown writes, safe retry boundaries, known-ID-only reconciliation, negative/missing statistics and company/post metric binding. Database tests exercise scheduling through the real adapter and durable journal to a verified receipt and metric snapshot, concurrent fencing, changed-context denial and no duplicate POST. These are not real platform publications.

Before activation, complete the designated company's OAuth, explicit text-post consent, one successful scheduled publication/read-back, actual organic metrics, denial/expiry/role-loss tests and worker configuration verification. No real post or paid AI call is authorized merely by this document.

Primary specifications: [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-07), [share statistics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics?view=li-lms-2026-07), [organization roles](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role?view=li-lms-2026-06).
