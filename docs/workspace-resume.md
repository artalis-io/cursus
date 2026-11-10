# Resuming a saved workspace

Cursus remembers the last displayed saved plan and its planning day in the current browser. This includes ordinary optimization results, manual plans, adopted plans and day baselines. Reopening Cursus reads that exact plan, its current scenario and the day's baseline through the authenticated API. It does not adopt, approve, or optimize anything.

The preference is isolated by tenant and signed-in user. It contains only versioned plan/day identifiers; it contains no plan contents, permissions, approval records or session credentials. The old tenant-only manual-workspace preference is intentionally not imported because its author's identity is unknown. Clearing browser storage removes the preference. Different devices and browser profiles do not synchronize it.

A surviving optimization job retains the existing resume priority: reconnect to its reference workspace and show its result as a candidate requiring an explicit decision. Merely restoring a saved plan cannot publish that candidate. Opening or navigating another tab never navigates an already open tab; the most recently saved browser preference applies to the next reopen.

Current API authorization, scenario revisions and approval checks remain authoritative. An unavailable/deleted plan falls back to the day baseline with a notice. A temporary read failure keeps the bookmark and offers Retry, rather than silently forgetting the last workspace. Malformed preferences are ignored; blocked browser storage cannot prevent normal planning. Optional route geometry loads separately and cannot replace plan statistics or manual intent.

Regression coverage lives in `web/acceptance/workspace-resume.spec.ts` and `web/acceptance/runtime.spec.ts`: malformed/scoped preferences, ordinary native plans, exact views without adoption, independent tabs, unavailable plans, transient retries, manual restoration with delayed geometry, and pending native candidate recovery. The production-image acceptance harness runs against isolated PostgreSQL/object storage and two Cursus replicas; it requires no private customer data or production credentials.
