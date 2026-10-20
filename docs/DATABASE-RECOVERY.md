# Database recovery and rehearsal

Marketingbus now has a repeatable synthetic database recovery check. It verifies a real PostgreSQL custom-format dump and restore, all public table fingerprints, schema constraints and critical application invariants. It does not establish production backup coverage, object-storage recovery or a recovery-time service commitment.

## Run the local rehearsal

Use an existing disposable local PostgreSQL container, Node 26 and installed repository dependencies. The database user needs permission to create and drop the two temporary databases. No Railway resource is created and no provider credentials are needed.

```sh
REHEARSAL_DATABASE_URL='postgresql://local_user:local_password@127.0.0.1:55439/local_database' \
REHEARSAL_DOCKER_CONTAINER='your-local-postgres-container' \
npm run test:restore
```

The connection must use a loopback address and explicit port, without query options. The runner checks that a local Unix-socket Docker context exposes that container's PostgreSQL port at the specified host port. Docker endpoint overrides are rejected. It never falls back to `DATABASE_URL` and never accepts a caller-supplied restore database or archive.

The runner creates collision-resistant `mb_restore_<random>_source` and `mb_restore_<random>_target` databases, applies all repository migrations to the source, and inserts synthetic records. The existing connection database is used only to create and remove these temporary databases; its application records are not read or modified. Existing database-name collisions stop execution rather than reusing a database.

The archive stays in memory, is limited to 64 MB and is SHA-256 checked before restoration into the fresh target. Restore uses one transaction and stops on errors. Snapshot reads use a repeatable-read, read-only transaction with bounded rows and bytes. Subprocesses have a one-minute deadline and receive a limited environment without inherited provider keys, production database configuration or Node injection options. No web server, worker or provider adapter is started.

On completion or handled failure, only databases successfully created by that run are removed. Cleanup never forces disconnection or deletes containers or volumes. If cleanup fails, the command fails and lists the exact temporary names for manual inspection. An abrupt host/process termination may leave those synthetic databases behind; inspect their exact names before cleanup, never use a wildcard deletion.

## Verified recovery properties

- Every public table's ordered row count and content fingerprint matches the backup checkpoint. Column definitions, indexes and constraints also match, including the migration history.
- A change made after the backup is absent from the restored target. Corrupt archive bytes and altered snapshot fingerprints are rejected.
- Tenant-scoped reads and composite foreign keys continue to isolate records. Credit operation keys and subscription-period uniqueness still reject duplicate entries.
- Held, settled and revision credits, refund debt and uncertain job/refund states survive restoration. Replaying a completed settlement is idempotent; altered or cross-tenant settlement is rejected. A synthetic resolution exercises refund-debt repayment without starting a worker.
- Encrypted social credentials decrypt with the original retained key after the active key changes. A missing original key or a different tenant context fails closed. No real provider token is used.
- Pending email remains pending with no provider receipt or delivery attempt. The test records asset metadata but does not recover or fetch bucket objects.

### Restored identity quarantine rehearsal

After proving backup fidelity, the runner now rehearses a separate identity-quarantine transaction on its fresh synthetic target. A read-only preview returns only table counts and a fingerprint; application requires that exact fingerprint and generated target name. The connected database is checked, writes to the seven identity tables are serialized with table locks, and row/byte/statement/lock limits fail closed. Changed content with identical counts, stale replay and concurrent application are rejected. An injected late database constraint failure proves all earlier mutations roll back.

The transaction invalidates every restored session and its temporary OAuth flow, marks unused verification/reset tokens used, revokes pending invitations, and expires queued/sending identity email while clearing encrypted payloads and leases. Sending-email attempts and any provider receipt are retained: quarantine is not a claim that an already-sent message was cancelled. Accepted/revoked history remains intact. All users receive a new authentication version. Pending MFA enrollment and restored recovery-code hashes are cleared; enrolled authenticators are retained and the consumed-TOTP fence advances through the quarantine time plus the verifier's one-step clock-skew window without moving backwards. Users must wait for a later authenticator code; real TOTP checks verify replay rejection and subsequent login-factor availability.

The rehearsal compares every unrelated table fingerprint before and after, preserving wallets, holds, memberships, provider credentials, jobs, uncertain publications and payment receipts. It verifies unchanged user identity/password fields and the untouched source database. No worker or email/provider transport runs. The helper is **rehearsal-only**, reachable through the existing loopback/container-validated runner; it is not an approved production quarantine CLI. A database name alone is not proof of isolation.

This does not reconcile post-backup password/factor changes, deleted accounts or revoked permissions; it does not disable outbound production queues or recover missing encryption keys. Production identity/queue quarantine, incident approval, authoritative revocation reconciliation and cutover acceptance remain required before reopening access. Users whose restored recovery codes are invalidated still need their enrolled authenticator or a separately verified recovery process; the rehearsal does not bypass MFA.

The JSON report contains hashes, counts, local timings and check names, not row contents, connection strings or encryption keys. GitHub CI runs the rehearsal against its disposable PostgreSQL service before the application build and browser tests. These fixture timings must not be advertised as production RPO or RTO.

## Production recovery procedure

Production restoration requires an explicitly approved incident scope, recovery point, target and any additional infrastructure cost. This rehearsal is not a production restore command.

1. Record the incident owner, database/service/environment IDs, backup or PITR identifier, UTC recovery point, deployed source revision and migration state. Verify actual backup coverage and the suspected data-loss interval. Do not infer recoverability from a successful application health check.
2. Freeze application writes and stop workers, scheduled runs and outbound execution. Keep AI/media, email, social publishing, billing and refunds disabled in the recovery environment. Avoid replaying incoming webhooks until their preserved event IDs and reconciliation state have been checked.
3. Restore into a separate isolated target, not over the current production database. Keep public traffic and provider callbacks pointed away from it. Preserve the original environment and an approved rollback path.
4. Recover the corresponding private objects and retained encryption key versions through their separate controlled procedures. Match object hashes and permissions against database references. Missing objects must block delivery. A SQL backup alone does not contain object bytes or the secret keyring.
5. Compare schema/migration state, row counts and audited business assertions. Check tenant boundaries, credit balances, held reservations, refund debt, payment-period uniqueness, approval versions and uncertain supplier/publication states. Use appropriately scoped protected evidence; do not dump customer rows into logs.
6. Invalidate restored sessions, one-use identity/invitation tokens and pending OAuth flows before reopening customer access. Reconcile account removals, permission revocations, deletion requests and retention events that happened after the recovery point; a restore must not silently reinstate access or deleted content. Review queued email and scheduled publications rather than sending them automatically.
7. Reconcile payments, refunds, AI jobs and social posts against authoritative external records. Preserve unknown outcomes as holds. Never infer that a missing local receipt authorizes another charge, generation or post. Verify idempotency history before replaying any event.
8. Run authenticated multi-user acceptance and private media read-back against the isolated target. Inspect deployment/worker versions and alerts. Record measured recovery time and data loss, including the object/key recovery steps.
9. Obtain explicit cutover approval, then move traffic in controlled stages. Enable each outbound lane separately only after its reconciliation is complete. Monitor failures, wallet drift, duplicate receipts and delivery errors; retain the approved rollback option.

Production backup scheduling, retained backup/key access, a real isolated Railway restore, object recovery, the identity/queue quarantine tooling and measured recovery objectives remain open acceptance items. SSO, organization MFA policy, load/chaos testing and independent security review are separate release gates.
