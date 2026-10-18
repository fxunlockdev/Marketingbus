# Business calendar

Calendar shows internal reservations across **all plans in the selected business**, independently of the selected campaign. It is not a receipt of publication or an automatic social-post scheduler. Actual destination schedules and receipts remain in Publishing & analytics.

## Customer workflow

1. Approve an exact copy version in Review inbox and place it on the internal calendar.
2. Open Calendar; select a month or Monday-based week. Select a day to filter the agenda. Times use the browser's timezone, shown on screen.
3. Use Move and the date form, or drag an agenda entry onto a day. Both propose a new instant and require explicit confirmation. Escape/cancel restores focus without writing.
4. Remove requires confirmation and removes only the reservation, not the creative. Calendar edits charge no credits and start no generation or publishing jobs.

The form displays the local UTC offset and exact UTC instant before submission. Nonexistent local times during spring daylight-saving changes are rejected. Repeated autumn minutes use the browser's first occurrence, shown in the preview; there is no arbitrary-timezone or repeated-hour selector yet. Month/week boundaries follow local dates, including 167/169-hour DST weeks.

## Integrity and permissions

- Business, workspace, membership and workspace MFA are checked on reads and writes. Owners, admins and editors may change reservations; other members are read-only.
- Moves require a confirmed current brand, current proposed plan, exact latest approved revision, no blocking comments and no active/unresolved copy job. Every condition is rechecked at mutation time.
- Changes/removals of existing reservations require their immutable ID and expected integer version. Concurrent requests serialize under the business lock; an old form gets 409 rather than overwriting a newer change. Old clients must refresh.
- Any linked SCHEDULED, SUBMITTING, NEEDS_RECONCILIATION or PUBLISHED social publication blocks both moving and removing its creative's internal reservation. This calendar never cancels, changes or resends that post. The former internal removal behavior that invalidated queued social publications has been removed.
- Obsolete internal reservations can be removed where no linked publication or active job blocks the operation. They cannot be moved until current approvals are restored.

## Bounded reads

`GET /api/businesses/:id/calendar` takes ISO UTC `start`, exclusive `end`, and optional `after` cursor. Ranges are limited to 42 days, between 2000 and 2100, with at most 100 entries per page. Duplicate/unknown parameters are rejected. Queries use a repeatable-read snapshot and `(scheduledFor,id)` ordering. An absent, out-of-range or foreign cursor is rejected; refresh after concurrent mutations. Counts describe only the current page, not a hidden business-wide total.

Responses expose only reservation IDs/times/versions, creative and plan labels, approval eligibility and safe reasons. They exclude copy content, prompts, provenance, tokens and raw provider records. Responses are private/no-store. No unbounded export or provider call is added.

Migration `20261018020000_calendar_versions` adds a version defaulting to 1 and a scoped keyset index. Existing reservation times, revisions, jobs and balances are unchanged. Runtime `studio-v22-business-calendar` checks the new column in readiness.

## Acceptance

Database tests cover all-plan reads, tenant/MFA/role boundaries, 101-entry pagination, malformed ranges, exact range endpoints, stale/concurrent changes, unchanged credit/job records, stale approvals, comments, current revision, invalid scheduling and linked social states. Date tests cover leap years, Monday-based weeks and both New York DST transitions. The browser journey covers actual scoped APIs, week/month views, keyboard focus, drag proposal/confirmation, stale edit rejection, removal, linked-post protection, automated accessibility and mobile width.

This does not complete social adapters, media autopilot, production hosted multi-user acceptance or the seven-module product. No real social post, email, payment or supplier generation is used for these tests.
