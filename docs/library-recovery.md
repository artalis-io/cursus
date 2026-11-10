# Recoverable saved-plan and scenario lists

Plans and Scenarios distinguish initial loading, a verified empty response, refresh in progress, and failure. Reads time out after 20 seconds instead of leaving an indefinite spinner. Retry repeats only the list GET. Successful refresh replaces the list and removes its read error.

A transient network/server failure keeps the last successful snapshot, explicitly labelled as potentially out of date. Reopening the same library checks for changes while retaining that snapshot. Scenario rename, delete and import are disabled until a fresh list succeeds; opening/exporting existing entries still uses the authoritative APIs. Approval, freshness and write authorization remain server-side checks.

Snapshots live only in each dialog's memory. They are scoped to authenticated actor, tenant, effective role/permissions and planning day. Identity/access/day changes discard the previous snapshot before it can be displayed. HTTP 401/403 responses discard cached rows and trigger the existing authentication refresh. No catalogue data is written to browser storage, and nothing is shared across users or browser tabs.

Closing a dialog or changing scope aborts its read and invalidates late responses. Newer requests supersede older ones. Mutation/export/import continuations use the same lifecycle boundary, so a late completion cannot refresh another day's dialog, trigger a download for a different identity or switch a newer workspace.

Read-state messages and controls are localized in English and Hungarian. Browser regression coverage uses the isolated two-replica production-image acceptance environment and public fixtures: first-load 503, a hung read with clock-controlled timeout, offline cached reopening, explicit refresh, successful empty responses, retry, delayed old-day reads, denied access, account switching, stale mutation controls and late rename completion. Existing server permission, tenant isolation, native optimization and candidate recovery tests remain in the full suite. No production changes or new persistence are required.
