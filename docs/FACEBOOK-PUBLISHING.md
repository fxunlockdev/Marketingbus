# Facebook Page text publishing

This adapter connects the existing approved-copy queue to Facebook Page text publication. It is not Instagram publishing, photo/video transfer, Page Insights ingestion or live-account acceptance.

## Activation

Keep `FACEBOOK_PUBLISHING_ENABLED=false` and `SOCIAL_EXECUTION_ENABLED=false` until designated-account acceptance. Registration requires both flags, `FACEBOOK_CONNECTIONS_ENABLED=true`, valid Meta credentials, an explicitly verified API version and unexpired verification deadline. Configure web and worker consistently. Existing connection permissions include Page discovery, engagement read, Page posting and Insights read. A grant is not proof that all endpoints work for the approved application.

The adapter accepts only a frozen approved Facebook text payload with no media. Immediately before submission and read-back it verifies the app-bound active Page token, required scopes, Page ID, applicable granular targets and current Page `can_post` capability. No customer token is sent to the browser. HTTP uses fixed HTTPS endpoints, bounded bytes/time, no redirects, no cache and generic errors.

## Submission safety

The worker's durable journal rechecks the current connection credential, account, payload and lease under the business lock. It permits one submission attempt and records its adapter version before the POST. The adapter sends the exact approved caption to `/{page-id}/feed`, with `published=true`, bearer authentication and app-secret proof. It does not ask Facebook to schedule a second remote job.

The returned candidate must be an exact Page-prefixed `page_post` ID. The journal persists it before read-back. The response is accepted only when the post ID, author Page and caption match, it is published and not hidden, the timestamp is valid, and returned attachment/parent/application data does not contradict this text-only application publication. A provider permalink is validated; no link is invented. Only a verified receipt sets the public publication status and external ID.

Temporary preflight errors can safely retry. Once the durable fence exists, a timeout, malformed response or server error is uncertain, never a reason to submit again. Known candidate IDs can be read back through the bounded reconciliation worker. A lost response with no ID remains held for operator investigation; the implementation never searches by caption to infer success or absence. Do not clear journal fields to retry.

This reuses the existing submission-journal migration; no new migration is required. Candidate validation is provider-specific and binds Facebook IDs to the selected Page. Concurrent journal attempts cannot create another POST. Credential or payload changes during work prevent receipt persistence.

## Metrics boundary

`metricsAvailable=false` explicitly disables the metric worker for this adapter, including older due rows. Successful publication and reconciliation leave `nextMetricsAt=null`; no all-zero/all-null fake snapshot is written. Account refresh is a separate read-only feature. Facebook per-publication Insights still needs a verified metric contract and implementation; it is not a missing API key alone.

## Verification and acceptance

Injected HTTP tests exercise the real transport, invalid tokens/scopes/roles/IDs/captions, safe retries, unknown responses, bounded body parsing, known-ID-only recovery, unsafe links and registry gates. Local PostgreSQL tests exercise scheduling, durable fencing, candidate persistence, read-back/reconciliation and disabled metric polling. Browser coverage checks the safe receipt display, unknown performance, access boundaries and automated accessibility. No fixture adapter is registered in production.

Before activation, obtain approved app permissions, perform OAuth on an explicitly designated Page, authorize one labelled test post, verify its actual response/read-back fields and platform ID, and test expiry/role loss and ambiguous-outcome recovery. Current provider documentation pages were unavailable during implementation. The official Meta SDK verifies the `feed` write edge and relevant fields, but it is not live version/account acceptance: [Page SDK](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/page.js), [PagePost SDK](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/page-post.js), [Python Page feed parameters](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/page.py).
