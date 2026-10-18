# LinkedIn company-page connections

## Scope and release boundary

The official server-side connection adapter exchanges a one-use authorization code, introspects the access token, discovers approved company-page administrator relationships and resolves each page's name. The existing session/business-scoped workflow then presents explicit account selection and stores the selected token encrypted. It does not publish content, transfer media, fetch performance metrics, refresh tokens or revoke authorization at LinkedIn. Those transports and live acceptance remain separate work. Personal profiles, showcase pages and non-administrator roles are not supported by this release.

No provider was enabled or contacted during automated verification. Tests inject HTTP responses into the real adapter; no fixture adapter can be enabled by a production environment variable.

## Operator setup

Keep `LINKEDIN_CONNECTIONS_ENABLED=false` until approved app access and a designated test account are available. On the web service only, configure privately:

- `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` for the approved application.
- `LINKEDIN_API_VERSION`: an explicitly supported six-digit `YYYYMM` version. No guessed/latest default is supplied.
- `LINKEDIN_API_VERIFIED_UNTIL`: UTC ISO timestamp within the next 90 days. This is an operator re-verification deadline, not proof of LinkedIn approval. Missing, expired or overlong deadlines disable new connections.
- Existing `APP_ORIGIN` and secret-encryption configuration must be valid.

Register the exact HTTPS callback `<APP_ORIGIN>/api/social/linkedin/callback` with the app. The requested permissions are `r_organization_admin`, `w_organization_social` and `r_organization_social`; approval for these must be verified in the LinkedIn developer application. There is no personal profile/email request. Enabling this connection flag does not enable `SOCIAL_EXECUTION_ENABLED` or register a publishing adapter.

Use LinkedIn's confidential web authorization-code flow with a client secret. Its separately documented native PKCE flow is not assumed to support this web redirect. The shared workflow still uses S256 by default for other adapters; confidential mode is code-restricted to LinkedIn's exact authorization endpoint. There is no runtime downgrade after an error. State remains random, hashed, single-use and bound to the initiating session, business and provider.

## Verification and limits

1. Exchange the authorization code exactly once using a form body over pinned HTTPS. Never retry an uncertain exchange.
2. Introspect the token and require an active three-legged grant for the configured application, all requested scopes and more than 60 seconds of remaining life. Persist the earlier of the exchange and introspection expirations.
3. Query approved `ADMINISTRATOR` relationships through the token's role-assignee finder. Support at most two pages of ten accounts; reject additional pages rather than silently drop accounts. Paging URLs are never followed: the adapter constructs the next numeric offset on the same pinned endpoint.
4. Accept only company URNs, reject duplicates/conflicting URNs or inconsistent role assignees, then look up each company and match its numeric ID and bounded display name.
5. Recheck current workspace membership, session and MFA policy before retaining candidates and at explicit selection. Temporary credentials expire after ten minutes and are erased on consumption/cancellation. The worker removes expired flows.

Each HTTP response is capped at 64 KiB of actual received bytes, including chunked responses, with a ten-second request timeout and a thirty-second whole-exchange deadline enforced by the calling workflow. Redirects, malformed/non-JSON responses and provider errors fail closed. No provider response body or token is copied into user-visible errors or audit events. No retries or third-party HTTP SDK dependencies were added.

Application credential, API version or verification-deadline changes invalidate pending selections through a one-way configuration fingerprint. Existing tokens are not silently refreshed. Expired connections require reconnection; publication must independently recheck credentials, scopes, role and expiry when its transport is implemented.

Migration `20261018020000_linkedin_confidential_oauth` adds the authentication method with an `S256` default and enforces provider-specific secret-state constraints in PostgreSQL. Existing S256 data remains valid. The new application configuration fingerprint invalidates pre-release pending callbacks; users must start those connections again. The migration is additive and does not delete stored social accounts. Do not roll back by dropping the column or rewriting migration history.

## Acceptance before enabling for customers

- Verify the current API version, approved permissions, company administration and exact callback in the designated application.
- With the account owner's consent, complete authorization, choose the expected page and confirm the encrypted connection and expiry. Confirm denial/cancellation, reconnect and removal of administrator rights fail safely.
- Verify the callback and recovery pages retain no-store/no-referrer behavior and never display codes/tokens.
- Do not describe this as working publishing or analytics until those adapters pass a separately approved real publication/read-back and metrics test.

## Primary specifications checked 18 October 2026

- [LinkedIn web authorization-code flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow)
- [LinkedIn native PKCE flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow-native)
- [Token introspection](https://learn.microsoft.com/en-us/linkedin/shared/authentication/token-introspection)
- [Organization access control by role](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role?view=li-lms-2026-06)
- [Organization lookup](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api?view=li-lms-2026-01)
