# Workspace MFA policy

Owners can require authenticator-based two-step verification in **Team → Workspace security**. The default is optional for both existing and new workspaces; migration never activates a requirement for customers.

## Changing the policy

The owner must have verified email and an enabled authenticator. Both enabling and relaxing the requirement need the current password, a fresh authenticator or one-use recovery code, explicit confirmation and the current expected policy value. Administrator/editor/viewer roles cannot change it. The server bounds request size and attempts, checks same-origin requests, rechecks current owner authority and authentication version, serializes policy/factor changes, and records a secret-free team event. A concurrent or stale toggle is rejected rather than overwriting newer policy.

Before enabling, tell teammates to verify their addresses and save their recovery codes. Unverified members need working Resend verification delivery to enroll. Do not enable a policy for a pilot team that cannot complete that process. Keep at least one enrolled owner with usable recovery codes; there is no customer MFA bypass or implemented operator break-glass recovery.

## Enforcement boundary

Every new session read filters protected memberships when the account has no enabled factor. Protected businesses, plans and wallet data are excluded from studio rendering. Business APIs reject those memberships; workspace team/billing/security endpoints check the requested workspace explicitly. OAuth callbacks also recheck the policy before exchanging or retaining grants. Existing pages cannot erase already-displayed or downloaded data; reload and subsequent requests enforce the current requirement. An already executing request is not forcibly interrupted.

Other workspaces remain accessible. Account security, email verification, password recovery and authenticator enrollment stay accessible. Invitation acceptance can create the membership but cannot grant protected workspace access before enrollment. Enabling a factor increments the authentication version and deletes prior sessions; a new sign-in with an authenticator or recovery code is required. Password recovery preserves enabled MFA. A user cannot disable a factor while any current membership requires it; removing a policy does not disable anyone's factor. These rules are checked on the server, not just by disabling a button.

Policy/factor mutation uses advisory lock `71403221` before user locks. The owner policy transaction follows user → organization ordering, consistent with OAuth/invitation operations. Audit records contain policy outcomes, not passwords, authenticator secrets or recovery codes.

## Jobs and accounting

This is an interactive-access policy. It does not cancel already-authorized copy/media/publishing jobs, release held credits, change supplier budgets, send email or execute a provider request. Existing worker authorization and reconciliation rules still apply. Use explicit job/run controls for cancellation.

## Release and remaining limits

Additive migration: `20261018010000_workspace_mfa`; web health checks the column. Runtime: `studio-v21-workspace-mfa`. Release web and worker from the same verified source after migration; never roll back to application code that ignores an activated MFA policy. A code rollback requires a policy-aware hotfix or stopping protected access, not silently downgrading enforcement.

Automated coverage includes role/tenant denial, current-password/auth-version/factor checks, existing-session gating, unrelated workspace access, enrollment/session revocation, disable-policy races, concurrent/stale toggles, safe audit projection, unchanged wallet and email state, and an OAuth callback started before enforcement. The browser journey covers confirmation via keyboard, protected team/billing/content denial, enrollment, owner-only relaxation, mobile width and automated accessibility. These are fixture checks, not an independent penetration test or hosted customer acceptance.

SSO, security alerts, production key-loss recovery, operator identity quarantine, full incident procedures and independent security review remain separate unfinished work.
