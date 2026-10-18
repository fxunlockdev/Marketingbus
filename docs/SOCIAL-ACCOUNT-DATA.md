# Facebook, Instagram and LinkedIn authorization and account data

## Delivered scope

The Connections screen contains publishing destinations only. Facebook Pages and linked Instagram professional accounts now have a server-side Facebook Login authorization adapter alongside the existing LinkedIn company-page adapter. An owner/admin starts a session-bound, ten-minute request, consents on the platform, returns to the fixed callback and explicitly selects an eligible account. Tokens remain encrypted with tenant/business/account context. Customers cannot submit raw tokens or arbitrary endpoints.

Read-only account data is an independent, disabled-by-default capability. An authorized admin deliberately refreshes one connected account. Viewers can view saved data but cannot refresh or remove it. No model calls, AI credits, social posts, learning promotions or billing events occur during refresh.

| Destination | Data mapped | Deliberately not inferred |
|---|---|---|
| Facebook Page | Name, available follower/Page-like counts; up to 20 published posts with text/date/permalink | Post impressions/reach/clicks/conversions; post engagement counts |
| Instagram professional account | Username, available follower/media counts; up to 20 media records with caption/date/type/permalink and available likes/comments | Reach/impressions/conversions, story insights and paid-ad attribution |
| LinkedIn company | Name; up to 20 published posts; available lifetime organic company impressions, unique impressions, clicks, likes, comments and shares | Personal profiles, follower counts, per-post metrics, paid conversions and causal improvement |

Missing fields remain null and display “Not available.” LinkedIn aggregate statistics are explicitly separate from the recent-post list. A denied/unavailable statistics endpoint does not become zero performance. Imported posts are not proof that Marketingbus published them and do not enter the existing publication metric/learning pipeline. This is not complete publishing or analytics integration.

## Private operator setup

Keep all new switches false until designated live-account acceptance. Use the web service's private configuration, never a customer form:

- `META_APP_ID`, `META_APP_SECRET` for the approved Meta application.
- `META_API_VERSION`: explicitly checked supported `vNN.0`; no assumed latest default.
- `META_API_VERIFIED_UNTIL`: UTC ISO deadline within 90 days; expired/missing configuration disables registration.
- `FACEBOOK_CONNECTIONS_ENABLED`, `INSTAGRAM_CONNECTIONS_ENABLED`: independent explicit flags.
- `SOCIAL_DATA_ENABLED`: separate read-only enablement; also requires the destination connection flag and its valid configuration.
- LinkedIn's credentials/version/deadline and approval requirements remain in [LinkedIn operations](LINKEDIN-CONNECTIONS.md).
- Existing `APP_ORIGIN` and secret-encryption keyring must be correct. Do not change supplier budgets or `SOCIAL_EXECUTION_ENABLED` to enable account reads.

Register exact callbacks `<APP_ORIGIN>/api/social/facebook/callback`, `<APP_ORIGIN>/api/social/instagram/callback` and `<APP_ORIGIN>/api/social/linkedin/callback` in the matching applications. The Meta route implemented here is Facebook Login with a Page-linked Instagram professional account, not Instagram Login or a generic Business Login configuration-ID flow. Verify the selected app use case supports this route before enabling; unsupported configurations need their own reviewed adapter.

Facebook requests `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`. Instagram requests `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`. Discovery requires content-management and analysis tasks on the Page. Platform approvals, business verification and advanced permissions are controlled by Meta/LinkedIn, not obtained automatically by creating the app. Requesting publishing scopes does **not** implement publishing.

## Verification and safeguards

Meta exchanges the code once, obtains a long-lived user token, verifies application/type/permissions/expiry, and discovers at most two pages of ten accounts. Paging links are never followed: only validated cursors on a code-owned endpoint are used. Each Page token is independently debugged and matched to the authorizing user and Page; Instagram linkage and identity are checked again. Required granular scope targets must include the selected Page/Instagram account. Stored expiry is the earliest known user/Page/data-access expiry, never indefinite simply because a Page token reports zero expiry. Partial grants, identity mismatches and ambiguous exchanges fail closed without retry.

The shared workflow uses random one-use hashed state, current session/role/MFA checks, a fixed callback and explicit selection. Meta and LinkedIn use restricted confidential-client exceptions; S256 remains the default for other adapters. Migration `20261018030000_meta_social_data` enforces provider/authentication combinations, paired snapshot/timestamp and lease fields, bounded JSON and a safe error vocabulary. It is additive and preserves existing accounts.

Every data refresh rechecks provider-token validity and account identity. Requests use pinned HTTPS, no redirects, ten-second individual timeouts, a thirty-second operation deadline and 128-KiB actual response limits. Reads fetch one page of up to 20 posts; a “more posts” notice is not complete archival coverage. Text excerpts are bounded to 5,000 characters and rendered as text. Links must use an allowed HTTPS platform host. No scraped content is interpreted as agent instructions.

A persisted two-minute lease and fifteen-minute per-account cooldown prevent parallel refresh storms. Route-level actor limits apply too. Session, membership, MFA policy, credential, account status, lease and configuration are revalidated before saving. Disconnect, local snapshot removal, credential rotation or access changes discard late results. Failed provider verification clears the saved snapshot rather than presenting it as newly verified. Refresh never retries automatically.

Snapshots expire after 30 days. Reads hide expired/disconnected authorization and expired snapshots; the worker removes at most 100 expired snapshots per maintenance pass. “Remove saved data” clears the current snapshot and cancels its in-flight save without deleting platform posts or authorization, and does not reset cooldown. Backups have a separate retention policy. Local disconnect erases local credentials/data, not remote platform grants. Revocation callbacks and token renewal remain unfinished.

**Logging gate:** Meta's documented token exchange/debug calls put credentials in server-to-server query parameters. The application deliberately never logs request URLs, bodies or raw provider exceptions; errors/audit projections are generic. Before live enablement, verify outbound proxy/APM query redaction for `client_secret`, `code`, `fb_exchange_token`, `input_token`, `access_token` and `appsecret_proof`, plus inbound callback query redaction. Never claim those credentials are absent from all URLs or platform logs. Customer-facing authorization URLs contain no client secret/token.

## Acceptance still required

1. Verify supported API versions, exact permission grants, route/use-case compatibility, token-debug field shapes, approved Page/company roles and callback domains using designated consenting test accounts.
2. Exercise consent, denial, explicit selection, insufficient role, expired/revoked token and removed Page/Instagram linkage. Confirm no secrets in browser/server/proxy/APM logs.
3. Refresh each destination and reconcile counts, dates, ownership, missing fields and LinkedIn aggregate semantics against the native platform. Verify real rate-limit behavior and revoke access mid-read.
4. Verify removal/retention, cross-business denial and hosted keyboard/screen-reader behavior. Automated fixtures do not replace platform or production acceptance.

Publishing/media upload, uncertain-write platform read-back, token refresh/revocation, webhook lifecycle, per-publication metrics ingestion and measured learning remain separate internal work. Neither `SOCIAL_DATA_ENABLED` nor OAuth registration populates the intentionally empty publishing registry. X and YouTube remain planned, not implemented by this release.

## Primary specifications checked 18 October 2026

- [Meta-maintained Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-1ff01566-3509-48bd-a0f4-8571a91ccfdf): Page tokens, tasks, linked accounts and Facebook Login route.
- [Meta token debugging example](https://www.postman.com/meta/whatsapp-business-platform/request/i1mz7w8/debug-token).
- [Official Facebook SDK OAuth client](https://github.com/facebookarchive/php-graph-sdk/blob/5.x/src/Facebook/Authentication/OAuth2Client.php) and [metadata model](https://github.com/facebookarchive/php-graph-sdk/blob/5.x/src/Facebook/Authentication/AccessTokenMetadata.php): exchange/debug wire shapes. These SDK sources are archived, so current-app acceptance is still mandatory. Meta's main developer pages returned HTTP 429 during research; their availability was not treated as API acceptance.
- [Current Meta-maintained Page model](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/page.py), [Instagram user](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/iguser.py), [Instagram media](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/igmedia.py).
- [LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-05) and [organic company share statistics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics?view=li-lms-2026-08).
