# Cursus workflow and usability review

Date: 28 October 2026  
Status: assessment and proposed implementation sequence; implementation is not authorized by this document.

## Purpose and scope

Improve workflow convenience, correctness, and user confidence while retaining Cursus's existing visual design, planning behavior, and role boundaries. Prefer small, independently reviewable changes over a broad redesign.

This assessment is based on the implementation, recent real Gyermelyi Playwright workflows, and captured UI screens. It is not a new authenticated production usability session. No application or production changes were made as part of the review.

Related documents:

- [Three-view workspace proposal and offline mockups](workflow-workspace-design.md) — 30 October design follow-up; not an application change.
- [Manual planning](manual-planning.md)
- [Plan review and freshness](plan-review-and-freshness.md)
- [Approved-plan handoff](approved-plan-handoff.md)
- [Dispatch readiness](dispatch-readiness.md)
- [Workspace layout](workspace-layout.md)

## Main finding

Users need a clearer answer to three questions: which plan am I viewing, can I trust its current evidence, and what will happen when I take this action?

The application already has many necessary safeguards. The next improvement is to make those safeguards consistent and understandable across plan selection, manual editing, optimization, comparison, approval, and export.

## Prioritized findings

Effort and risk below are relative assessments, not delivery estimates. Code observations should be rechecked against the implementation revision before work starts.

| Priority | Finding | Proposed change | Impact and risk |
|---|---|---|---|
| 1 | Scenarios lists results without a usable Open action in the stateful workflow. Users must find the plan through Plans. | Restore working Open actions and consistent navigation between scenario and saved-plan lists. | High gain; low risk |
| 1 | Some comparisons and bulk selections use order numbers, which can repeat. Distinct deliveries can be collapsed or become ambiguous. | Carry stable delivery IDs through comparison, selection, and drag-and-drop. Visibly distinguish repeated references. | High correctness gain; medium risk |
| 1 | KPI colors can contradict comparison warnings: lower cost or distance can appear as an improvement despite lost service. | Share comparison rules across all surfaces. Coverage, dataset scope, tariff identity, and constraint-policy compatibility must govern improvement claims. | High trust gain; medium risk |
| 1 | Replan automatically switches the displayed result, including when coverage worsens. | Present a new result as a candidate, keep the previous plan available, and offer Use candidate, Keep previous, and Compare. Preserve both results and their approval history. | High gain; medium risk |
| 2 | Live, Draft, validity, freshness, and pending edits compete for attention. | Introduce a compact plan identity/status area with separate feasibility/coverage, freshness, and approval indicators. Put solver termination details in Details. | High clarity gain; low–medium risk |
| 2 | Manual edits and optimizer instructions look similar but have different effects. | Explain the consequence beside each action: Preview and save now versus Applied on Replan. Make manual mode visibly active. | High convenience gain; medium risk |
| 2 | Failed plan-list requests can appear as an empty list. | Separate loading, empty, failed, and stale states. Provide Retry and retain the last successful list where appropriate. | High gain; low risk |
| 2 | Hungarian approval blockers lose the detail available in English. | Localize structured blocker reasons and add direct recovery actions, such as viewing unassigned orders or reloading the current revision. | High gain; low–medium risk |

## Workflow recommendations

### Select and resume a plan

- Remember the last opened plan and day within the tenant and authenticated user's workspace, including ordinary saved native plans.
- Restore selection safely after reload. An inaccessible or deleted plan must not prevent opening the workspace.
- Show Draft, Reviewed, Approved, or Superseded in the saved-plan list.
- Make the currently displayed plan unmistakable, with its name, day, revision, and saved or pending state.
- Keep scenario and saved-plan navigation consistent. Both should lead to the intended exact plan, rather than silently choosing an unrelated latest result.
- Do not introduce an original handmade-plan dependency. Comparison references should be explicit existing plans chosen for the workflow.

### Understand plan status

Represent independent facts separately:

| Dimension | Example states |
|---|---|
| Coverage and constraint evidence | Complete and checked; unassigned orders; violations; evidence unavailable |
| Freshness | Matches scenario revision; edits pending; source or policy changed |
| Approval | Draft; Reviewed; Approved; Superseded |

Live is a source/execution description, not proof of feasibility or approval. A successful solver termination must not imply complete service, and an approval indicator must remain bound to the exact plan and revision.

Use the existing readiness, issues, and approval components as the basis for a compact status area. Avoid adding more competing notification bands. Important blockers should remain visible, with detail and direct navigation available on demand.

### Edit manually

- Distinguish immediate preview-and-save operations from instructions that take effect on Replan.
- Show whether manual mode is active and explain why an action is unavailable.
- Preserve the distinction between available, excluded, and unverified/unavailable vehicles.
- Explain manual retention and Let optimizer decide in plain language.
- Preserve the existing assignment-origin and change-history evidence.
- Use stable delivery identities even when display order numbers repeat. Do not guess identities for historical plans lacking sufficient evidence.
- Route blocker actions to the relevant order, vehicle, trip, or filtered issues list instead of requiring users to search again.

### Replan and choose a result

Recent isolated Gyermelyi tests produced the following coverage for 7 May after manual workflow operations:

| Budget | Interface | Served |
|---|---|---:|
| 30 seconds | UI | 144/146 |
| 240 seconds, full budget | UI | 143/146 |
| 600 seconds, eight threads, HGS | API | 146/146 |

These are observations from specific runs, not quality or reproducibility guarantees. Longer runtime cannot guarantee a better result on every run.

- Keep the previous validated plan available when a new result arrives.
- Present explicit coverage, constraint, cost, distance, vehicle, and trip differences before adoption.
- Keep a worse candidate as a separate draft; never transfer approval from another plan.
- If retaining a previous plan after scenario edits, label whether it still matches the current constraints. Do not present an outdated plan as current or feasible under changed restrictions.
- Offer named solve presets, such as Quick, Standard, and Thorough, with their actual durations visible. The reviewed UI caps its slider at 240 seconds; the ten-minute check used the API.
- Any longer preset must respect server-side budget and concurrency controls.
- Investigate seeding from an existing feasible plan as a separate solver-integration task. Do not promise incumbent preservation without native validation, crash/fencing tests, and compatibility with changed constraints.

### Compare, review, and export

- Apply the same comparison interpretation to the KPI strip, readiness panel, comparison dialog, and exports.
- Do not describe lower cost or distance as efficiency savings when service was lost.
- Compare delivery identities, not only counts or display references. Equal totals can hide a different set of served deliveries.
- Check dataset scope, tariff identity, currency, and constraint-policy compatibility before making like-for-like claims.
- Make the comparison reference explicit; no original-plan feature is required.
- Retain server-authoritative review, approval, and export checks. Client-side labels must not grant permission or approval.
- Localize actionable blockers in both English and Hungarian.
- Preserve ordinary Draft exports. Approved exports must continue to reject stale or unapproved plans.

### Recover from errors

- Show an empty state only after a successful request confirms there are no records.
- On a failed request, explain what could not be loaded and offer Retry.
- Where safe, retain previously loaded content with a clear stale indicator.
- Treat unavailable approval evidence as unknown, not approved; explain the problem visibly.
- Preserve unsaved intent through recoverable failures without silently applying it to a newer revision.

### Reduce visual friction

- Keep the day, plan name, Replan, and Export prominent.
- Group secondary navigation to reduce header crowding. Recent 1440px captures squeeze the scenario label and navigation.
- Use readable truncation with access to full names, including keyboard and assistive-technology access.
- Preserve the existing resizable panels, collapse controls, and overall design language.
- Prefer direct links from status messages to existing panels over adding new panels.

## Suggested implementation milestones

### 1. Navigation and status correctness

Implement consistent Open actions, error-versus-empty states, approval labels in plan lists, safe plan restoration, and detailed localized blockers. Keep solver behavior unchanged.

### 2. Comparison correctness

Use stable delivery identities and shared comparison rules across summaries, dialogs, selection, and exports. Include duplicate-reference and changed-policy cases.

### 3. Safer planning workflow

Implement explicit candidate adoption, clearer manual-action consequences, and solve presets. Treat solver incumbent reuse as a separately validated engineering change.

## Acceptance and regression coverage

Use small public fixtures for checked-in tests. Keep private customer fixtures, screenshots, and results outside Git and Docker build contexts.

| Area | Required evidence |
|---|---|
| Navigation | Open the intended plan from both lists; switching days, reloading, and browser navigation preserve the correct tenant/day/plan context. |
| Restoration | Reopen ordinary native and manual plans after reload; deleted or unauthorized selections recover safely without cross-tenant fallback. |
| Identity | Distinct deliveries sharing an order number remain independently selectable, movable, counted, and compared. Ambiguous historical identities fail clearly. |
| Comparison | Coverage loss with lower cost/distance never receives an efficiency-improvement signal; equal served counts with changed deliveries are detected. |
| Compatibility | Changed datasets, tariffs, currencies, and constraint policies receive explicit comparison limitations. |
| Manual workflow | Assignment, deassignment, exclusion, restoration, Undo, and Replan preserve identity, origin/history, accurate KPIs, and hard constraints. |
| Candidates | A worse result does not silently replace the chosen approved plan. Keeping the previous result preserves history and clearly reports any scenario mismatch. |
| Approvals | Concurrent edits and approvals across both replicas cannot approve stale data or transfer approval to a new candidate. |
| Exports | Draft and Approved labels, exact plan/revision, counts, costs, constraints, and exceptions remain consistent; stale Approved exports fail server-side. |
| Failure handling | Network errors, partial failures, and replica unavailability do not appear as empty data or discard recoverable work. Retry does not duplicate mutations. |
| Permissions | Admin, Planner, Reviewer, and View as behavior remain enforced in the UI and API, including delayed responses and role changes. |
| Accessibility and language | EN/HU, keyboard operation, focus restoration, narrow layouts, long labels, and non-color status cues remain usable. |

Run targeted tests and the existing authoritative server/integration suites and exact-image Playwright acceptance before release. Separate executed evidence from proposed or unexecuted tests. Introduce changes in small releases with explicit rollback, preserving customer data and existing approvals.
