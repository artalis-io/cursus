# Fleet operating profiles

Fleet profiles now include a paired shift window, maximum trips, maximum distance and maximum duration per vehicle. These are part of the existing dataset-scoped, append-only approval workflow in **Prepare → Fleet & sites → Planning profiles**. No migration or implicit profile activation is required.

A Planner may propose a revision, with a name and change reason. An Admin approves it. A dispatcher must explicitly pin the approved revision to a scenario and Replan. Approval alone never edits a scenario, historical plan or admitted input. Reviewer and Admin “View as Reviewer” remain read-only. Concurrent edits use existing If-Match/version checks, tenant scoping and audit records.

## Meaning and precedence

| State | Meaning |
|---|---|
| Unknown / source settings | Preserve the admitted source value. This is not a promise of unlimited operation. |
| Unlimited | Explicitly remove the shift window, or pass zero for native trip/distance/duration maxima. |
| Configured | Apply the approved numeric bound. Shift start/end are stored together. |

Precedence is admitted source → pinned approved profile → temporary scenario override. Overrides may tighten configured profile bounds, but cannot start earlier, finish later, increase a maximum, or bypass a positive maximum using zero. Relaxing an approved bound requires another approved profile revision. Unknown and unlimited profile fields can still be narrowed by scenario overrides. Clearing an override restores the pinned profile/source value.

The shift editor accepts HH:MM or HH:MM:SS from 00:00 through 48:00. Overnight shifts use the following-day hour (for example 22:00–30:00). Midnight is a literal boundary, not unlimited. Native shifts are paired because Surge's JSON reader reads shift_late only alongside shift_early. Scenario-only shift changes on a profile-backed vehicle fill a missing counterpart with 00:00 or 48:00, and reject reversed windows.

Distances are entered in kilometres and converted to metres exactly once. Duration is entered in minutes and stored as integer seconds. Maximum trips is a positive integer. Configured zero maxima are rejected; use Unlimited explicitly. Source omission preserves Surge's existing default (notably omitted max_trips means one, whereas zero means unlimited).

Duration covers the vehicle's elapsed working day from its first departure through final return, including waiting, service and inter-trip gaps. Distance and trip count cover the whole vehicle day. A configured approved duration enables Surge's existing hard-duration setting for that solve; this native setting is request-wide and also enforces any other effective duration bounds in that request. HGS parameters, objectives and native source revisions are unchanged. An independent result check rejects publication outside configured approved bounds, including aggregate multi-trip bounds.

## Saved evidence and manual planning

Saved fleet evidence includes effective operating states and values, alongside its plan/revision/input binding. Explicit unlimited displays as Unlimited; older plans retain unknown evidence. Contradictory state/value metadata invalidates the fleet snapshot rather than displaying fictitious headroom. The inspector shows recorded operating settings separately from staged overrides; actual trip count or distance is no longer used as a limit placeholder.

Manual validation and native replanning receive the same profile policy. Manual commits retain operating settings together with tariff, fleet and reload evidence. Changing that policy requires reconciliation, rather than silently altering a saved draft. Input replacement carries the limits in its retained settings and preview identity. Profiles with retained manual decisions still require a clean scenario before rebinding, as before.

Approval/export checks require compatible recorded evidence for configured policies and check actual vehicle-day bounds. Ordinary draft exports remain available. This is an operating envelope, not a certificate for statutory driver breaks, axle loading, live traffic or every delivery constraint.

## Compatibility and verification

The optional operatingLimits field is additive to profile schema 1. Missing fields preserve existing source behavior. Existing immutable profile revisions, plans, datasets and their hashes are not rewritten. Old application versions do not understand this field; do not pin new operating profiles until all serving replicas support them. Rolling back after using these profiles requires an application version that understands the contract, or an explicitly reviewed restoration of compatible profile bindings.

Regression coverage includes strict states and bounds, zero/midnight semantics, unit conversion, override ceilings, retained manual drift, native boundary serialization, saved-fleet consistency, two-instance profile governance, native/manual parity and Playwright profile editing/pinning/replanning. Tests use non-confidential fixtures and disposable PostgreSQL/S3-compatible services. No production state is needed or changed.
