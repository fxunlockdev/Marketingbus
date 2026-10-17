# Workspace MFA release — 18 October 2026

Source: `ba0b16573a6339654c33091e5d3819f9adc84945`. Runtime: `studio-v21-workspace-mfa`. Additive migration: `20261018010000_workspace_mfa` (32 migrations total). Existing and newly created workspaces default to optional MFA.

## Verified delivery

- Local and [GitHub CI 39064155837](https://github.com/fxunlockdev/Marketingbus/actions/runs/39064155837): 525 unit/database tests in 42 suites; 29 browser journeys; production build/type checking; dependency audit with zero known vulnerabilities. One private-storage journey remains skipped.
- Isolated local and CI PostgreSQL restore rehearsal: 32 migrations, 52 tables and 58 synthetic rows, tenant/ledger/key checks and unchanged uncertain operations. Temporary databases removed. This is not a production backup/object restore.
- Nine new database cases cover policy authority, factor/auth-version/password checks, current-session tenant gating, enrollment, factor-disable races, concurrent/stale toggles, non-secret audits, unchanged wallets/email and an OAuth callback begun before enforcement.
- Browser acceptance covers owner confirmation via keyboard, fresh-code proof, protected team/billing/business denial, unrelated-workspace visibility, enrollment/relogin, denied administrator changes, disabled factor removal, owner relaxation, mobile width and automated accessibility. Tests use only local synthetic accounts and no external provider transport.
- An outdated health-query test count and a dropdown visibility assertion failed in initial local verification and were corrected before the full passing runs.

## Deployment

Both services were uploaded from a fresh tracked-file archive of the tested source commit, excluding local secrets, dependencies and test artifacts. No infrastructure resource, variable, execution flag, budget or customer policy was changed.

| Service | Deployment | Observed result |
|---|---|---|
| Worker | `dfcf480c-210f-473e-aaca-3c7a8cc02038` | SUCCESS; migration applied; worker startup and platform health succeeded |
| Web | `38fa77dc-e91a-4435-8bcb-731ee3c3629d` | SUCCESS; 32 migrations present with none pending; server ready |

Live anonymous checks: `/api/health` returns 200/`ok`/no-store; `/studio` returns 307 to `/login`; the new workspace security POST and team GET return 401/no-store. The rejected POST does not update any workspace. No real account was created or altered for smoke testing. There were no paid model calls, real emails, charges/refunds or social publications in this pass.

## Scope and remaining gates

See [workspace policy operations](WORKSPACE-SECURITY.md). This implements workspace MFA enforcement, not SSO or a complete enterprise security program. Existing authorized background jobs and financial holds are unchanged. Already delivered pages/files cannot be recalled by this policy. Hosted authenticated customer acceptance, Resend delivery, key-loss/break-glass recovery, production restore/quarantine procedures, monitoring, independent security review and the unfinished media/social/automation modules remain separate gates.

CI reported runner/action-version deprecation notices, not failed checks. Runner-image/action updates should be verified independently rather than conflated with this application release.
