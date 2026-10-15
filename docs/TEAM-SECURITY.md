# Team and MFA operations

## Workspace membership

The Team screen manages the selected business's organization, not one business alone. OWNER and ADMIN can invite EDITOR/VIEWER members. Only OWNER can assign privileged roles. Organization-level row locking prevents concurrent operations removing/demoting the last owner. Member/invitation actions create team audit events. Removed membership blocks subsequent authenticated workspace requests; this does not promise cancellation of an already accepted production job.

Invitations require the inviter's verified email and configured Resend delivery. They are email-bound, expire in 24 hours, are stored as hashes, are consumed once under lock and must be accepted by the exact verified recipient. The acceptance flow rechecks the inviter's current authority. No invitation token is returned from member-management endpoints. The encrypted email outbox stores the token until delivery/expiry. Revocation clears its pending content. Quotas: ten invitations per organization per hour; fifty members plus pending invitations per workspace; twenty workspaces per user; global email quota also applies. New recipients still need pilot registration; invitation-aware signup is pending.

## Authenticator MFA

Account settings supports time-based authenticator enrollment with a manual secret (SHA-1, six digits, thirty seconds), a ten-minute confirmation window and eight random single-use recovery codes. Password and verified email are required for setup. The secret is encrypted with context-bound AES-GCM; only recovery-code hashes are stored. Successful setup/disabling increments the account authentication version and revokes all sessions. A password reset also revokes sessions but deliberately does not disable MFA.

Login checks the password first, then consumes a fresh TOTP step or recovery code under a user row lock. The same TOTP step cannot be used twice, including simultaneous requests. One adjacent time step in either direction accommodates clock drift; reusing a recent authenticator code fails, so wait for the next code. MFA-management requests are rate limited. Disabling requires the current password plus a factor. There is no public administrative MFA bypass. There is no SSO, passkey, organization-wide MFA enforcement or formal security certification.

Configure `SECRET_ENCRYPTION_KEYS_JSON` and `SECRET_ENCRYPTION_ACTIVE_KEY` privately. Preserve old keys until **all** associated MFA/social/email records have been re-encrypted or removed. Never delete a key just because email queues are empty. Losing keys can lock out enrolled users; a tested backup/key-rotation and identity recovery process is required before public launch. Browser tests use a disposable in-memory keyring and synthetic users, never production secrets. Do not upload MFA test traces publicly: even fixture secrets should be treated as sensitive artifacts.

Local verification covers RFC 6238 vectors, replay/skew, password-reset behavior, concurrent factor consumption, encryption, recovery-code reuse, invitation expiry/revocation, cross-workspace access and concurrent last-owner changes. Live email acceptance and independent security review remain separate release gates.
