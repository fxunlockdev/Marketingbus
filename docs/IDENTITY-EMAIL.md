# Resend identity email — activation and limits

Implemented: account security screen, explicit email verification, password recovery, single-use expiring tokens, encrypted transactional outbox and a bounded Resend worker. The 15 October source also implements workspace invitations and authenticator MFA; see [team/MFA operations](TEAM-SECURITY.md). SSO and mandatory verified-email enforcement for the entire private pilot remain unimplemented.

## Activate only after sender verification

Configure privately on web and worker:

- `RESEND_API_KEY`: sending key for the verified domain.
- `RESEND_FROM_EMAIL`: plain email address on that domain.
- `APP_ORIGIN`: canonical HTTPS application origin, no credentials, query, fragment or path.
- `SECRET_ENCRYPTION_KEYS_JSON`: key-ID-to-base64 map of independent random 32-byte keys.
- `SECRET_ENCRYPTION_ACTIVE_KEY`: current key ID. Never reuse an API key as an encryption key.
- `EMAIL_DAILY_LIMIT`: conservative rolling allowance, default 100; maximum 1,000. This is not a provider billing guarantee.
- `EMAIL_DELIVERY_ENABLED=true`: only after authorizing a designated live-test recipient and checking these settings. Until then the UI clearly reports delivery unavailable.

Reference web secrets from worker variables; do not duplicate them into source, screenshots or chat. Keep previous encryption keys until every email, social-token and MFA record using those keys is re-encrypted or securely removed. Email expiry alone is insufficient: MFA secrets and social tokens are long-lived. Losing a key can lock users out. No production key has been generated or activated by this release.

## Security and delivery behavior

- Random 256-bit links; SHA-256 hashes in the token table. Tokens are scoped to verification or recovery. Recovery expires after 30 minutes, verification after 60.
- Links put the bearer token in the URL fragment, not query parameters or access logs. The browser removes the fragment from history immediately and requires explicit submission. Merely opening a link does not consume it.
- Queued messages (including the link) use AES-256-GCM with fresh nonces and authenticated outbox/user context. Ciphertext cannot be transplanted to another record/user.
- No account-existence result is returned by recovery requests. Endpoint and per-user limits apply; the global durable email allowance survives customer deletion. This is not a claim of eliminating all timing side channels.
- Reset consumption is atomic and race-tested. It updates the password, increments the authentication version, removes every session, and invalidates sibling reset tokens. A concurrent login cannot create a session using an obsolete password version. New passwords reject bcrypt's 72-byte truncation boundary.
- Fixed Resend endpoint, 15-second request timeout, bounded responses, five attempts maximum and identical idempotency key/body. Retry windows end at token expiry, well within Resend's documented 24-hour idempotency window. Permanent errors stop without retry. `ACCEPTED` means Resend accepted the request, not delivered to an inbox. Delivery webhooks/bounce handling remain future work.
- Encrypted content is cleared on acceptance, permanent failure or expiry. Independent worker maintenance clears expired queued content even when sending is disabled; expired token metadata retained up to seven days, terminal email metadata up to 30 days. Database backup retention is separate.

## Evidence

Database tests cover ciphertext tampering, wrong-context reads, rotation, token replay/expiry/purpose, simultaneous resets, session revocation, quota, retry ambiguity and expired-mail cleanup. Browser tests exercise explicit verification, password confirmation errors, session revocation and old/new credential behavior. They use synthetic localhost accounts and injected Resend responses; no real email was sent.

Official contracts: [Send Email](https://resend.com/docs/api-reference/emails/send-email), [Idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys).
