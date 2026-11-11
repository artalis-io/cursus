# Saved-plan schedule resilience

Schedule resilience is a collapsed disclosure inside the existing Review details.
It adds no top-level dashboard band. Admin, Planner, Reviewer and View as can
inspect it, filter stops, run local checks and navigate to the existing inspector.
No plan changes, jobs, network requests or matrix loads are initiated by the
analysis. Existing role checks still govern all editing and optimization actions.

## Deadline review

Closing slack is recorded window closing minus **service start**, matching the
native Surge service-start deadline rule. It is not time until opening, an
arrival-only buffer, or a requirement to finish service before closing. Equality
is on time. Recorded early waiting is displayed separately.

Stops are ranked by closing slack, with negative values first and unknowns last.
The initial filter includes late, at-most-thirty-minute and unknown stops; all
assigned stops are available. Thirty minutes is a review threshold, not a new
hard constraint, solver parameter, approval blocker or reliability score.
Unassigned deliveries remain in the existing Coverage section.

Invalid or missing times/bounds and unsupported stop types remain Unknown.
Historical zero closing bounds are ambiguous: the plan may have lost an omitted
bound or may describe a midnight point window. Do not interpret zero as unlimited.
Positive point windows remain valid; service can start exactly at closing and
finish later. The route-inspector rationale uses the same closing-slack rule,
so it does not count arrival slack while Review counts service-start slack.

Repeated order numbers are never merged. Navigation reuses existing stable-target
validation, including request ID, vehicle, trip and sequence. If historical
identity cannot be resolved uniquely, the label has no navigation action.

## Fifteen/thirty-minute departure checks

An opt-in local check delays the **first planned departure of every used vehicle**
by exactly 900 or 1800 seconds. Assignment, route order, service durations and
travel legs remain fixed. It does not run HGS or construct a revised plan.

The shared timing kernel in `server/src/plan/timing.ts` is extracted mechanically
from the existing manual evaluator: maximum of planned departure versus previous
return plus required reload, then service start at maximum of arrival versus
opening. The manual evaluator uses the same kernel. Rates, objectives, constraint
checks and all remaining manual evaluation behavior are unchanged.

Replay uses saved leg times, exact departure-minus-service-start durations and
the saved depot-return leg. Later trips depart at the later of their planned
anchor and delayed previous return plus verified required reload. Opening waits
and genuine spare inter-trip gaps can absorb delay; the implementation does not
add fifteen minutes to every ETA or treat the entire depot gap as free time.

A zero-delay replay must reconcile with the saved schedule within one second
before a delayed result is shown. Trips must not overlap. Unexplained waiting,
missing bounds, unsupported task models, invalid fleet evidence or missing
multi-trip reload data withhold affected vehicle results. No current deployment
settings are substituted for missing historical facts.

A single-trip plan can assess its recorded stop deadlines without fleet evidence;
unrecorded shift/duration limits remain unassessed. Multi-trip propagation requires
the immutable fleet snapshot's required reload. Known shift end and maximum route
duration are checked separately. Shift counts are per vehicle, not one count for
each late-returning trip. Duration measures first departure to final return; a
later departure may consume opening wait rather than increase duration.

The view reports existing versus newly late stops, saved/delayed service starts,
closing slack, return time and recorded limit comparisons. Counts cover assessed
vehicles/bounds only. It does not certify other route constraints, alter approval,
or predict live traffic. Missing evidence is visible even when no assessed stop
is late. No result contains an authoritative feasibility/approval boolean.

## Identity, lifecycle and resource boundaries

The existing tenant-bound plan API remains the sole read boundary. No new endpoint,
permission, dependency, schema or persisted field is introduced. All calculations
consume the displayed immutable plan, including its bound fleet snapshot. The
scenario/pending indicator warns that edited settings are not included.

Filter/page/delay state is local. Switching plan, scenario or revision resets the
check; geometry enrichment does not change the saved inputs. No extra browser
request can finish late and overwrite another plan's analysis. Each calculation
is a fixed pair of baseline/delayed traversals over the saved routes; there is no
unbounded search, native process, server queue or database transaction.

## Verification

Independent literal fixtures and the full matrix-based manual evaluator cover
service-start versus arrival/completion, equality, opening-wait absorption,
required reload and spare depot time, downstream trips, repeated references,
existing/new lateness, shift and duration limits, missing/bad evidence and empty
plans. Existing manual suites verify the mechanically extracted timing kernel
preserves schedules, costs, constraints and KPIs.

Two independent APIs exercise Reviewer retrieval, tenant denial and unchanged
JSONB plans while computing the derived view. Production-image Playwright covers
all roles, EN/HU narrow layouts, unchanged saved KPIs and peer results, exact stop
navigation, manual-save replay, pending scenario edits, historical missing bounds
and reset on day navigation. The existing leave-scenario confirmation is accepted
explicitly in the navigation test; it is not bypassed in application code.

Full release evidence must distinguish executed synthetic/native tests from
optional/private tests. No production activation is implied by this document.
