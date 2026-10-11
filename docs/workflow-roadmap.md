# Cursus: workflow roadmap (the "decision cockpit" framing)

Status: direction + priorities. Drag-to-reassign is the first build off this doc.

## Positioning: a decision cockpit, not a system of record

Cursus is deliberately **not** a TMS / order database / execution tracker.
It sits *beside* the customer's existing systems and does one thing well:

> **read a snapshot (orders + fleet) -> optimize -> let a human tune it -> explain it -> hand the tuned plan back.**

Everything inside that arrow is in scope. Anything that *stores operational truth
over time* belongs to the customer's system of record, not here. Not being the SoR
is a feature: it keeps the integration orthogonal (per the transport-agnostic
manifesto and the "keep the dispatch integration orthogonal" rule) and means the
tool is useful without having to win the data-ownership fight.

The inbound half of the arrow is already built: the onboarding pipeline
(upload CSV/XLSX -> map columns -> reconcile gate -> geocode -> matrix -> admit,
with a custom fleet). The gaps are in *tuning*, *comparing*, *explaining*, and the
*outbound* handoff.

## Explicitly OUT of scope (system-of-record tells)

Building any of these would turn the cockpit into a TMS and is a non-goal:

- Individual order CRUD / an inbound order inbox (orders arrive as a snapshot).
- Driver roster, send-to-driver, driver acknowledgment, a driver mobile app.
- Live execution tracking: actual-vs-planned, ETAs/PTA, stop check-off (telematics/ELD/Pulse own this).
- Persistent plan lifecycle states (draft/published/dispatched) as owned records.
- Multi-day calendar of stored plans; analytics/KPIs over time; a who-changed-what audit trail.

These assume the tool owns the operational timeline. It doesn't.

## In scope: the five priorities

### 1. Human-in-the-loop tuning + re-optimize  (building now)
The core of a cockpit: the dispatcher *collaborates* with the optimizer rather than
accepting or rejecting its output.
- **Drag-to-reassign** an order onto a different vehicle (and place an unassigned
  order). Maps onto the existing `pin` edit (`allowed_vehicles=[v]`), stacks on the
  editable scenario, and is honored on Replan. **This is the first build.**
- **Manual stop resequencing** within a trip (drag to reorder). **DONE.** It turned
  out no C change was needed: `sg_api_build_model` already parses
  `precedences:[{before,after}]` from the request JSON into `sg_add_precedence`
  (verified a forced order flips the solver's natural sequence). So it is pure Node +
  frontend: a `setSequence`/`clearSequence` `ScenarioEdit` + `VehicleSequence` on the
  scenario; `applySequences` locks the ordered orders to the vehicle
  (`allowed_vehicles`) and chains precedence between consecutive ones; a drag-to-reorder
  stop list in the Inspector (same drag as reassign, but dropping on a sibling stop
  reorders). A feasible order is honored; an infeasible one (breaks a hard time window)
  correctly drops the conflicting order as unassigned.
- **Lock-and-resolve**: freeze some decisions (pinned assignments, a fixed partial
  sequence), let the solver fill the rest. Falls out of the two above plus the
  existing pin/forbid model.

### 2. What-if depth  (the actual differentiator)  [DONE]
A decision tool exists to *defend a choice between options*.
- ✅ Scenario workspace (TopBar "Scenarios"): lists the day's scenarios (base +
  what-if copies) with each one's latest result; rename (to tell them apart), open
  (switch to it), delete copies. Backend `GET /api/scenarios?day`, rename, delete +
  scenario GC (copies were previously unbounded).
- ✅ **Side-by-side multi-scenario compare** (2-3): Served / Vehicles / Distance /
  Cost / Unassigned, best value per row highlighted.
- ✅ Share/export a scenario: export its edit stack as a portable JSON; import
  recreates the same what-if and adopts it as the current scenario.

### 3. Explainability / trust  (what converts a skeptical dispatcher)  [why-unassigned DONE]
A cockpit nobody trusts is shelfware. The raw material exists (advisories, Sage
narration); make the optimizer legible.
- ✅ *Why is this order unassigned?* Surge emits no reason, so `classifyUnassigned`
  infers one (pin/sequence lock that failed, needs tail lift, over capacity, access
  tonnage, else generic time-window/routing). Shown in the Issues panel (below).
- ✅ *Why this sequence?* a per-route rationale in the trip view (window-driven vs
  distance-driven + counts of late / tight / early-waiting stops).
- *Why infeasible?* surface the binding constraint, not just a failure. (partly: the
  unassigned reason now names the likely blocker)

### 4. The outbound handoff  (what makes it deployable)  [DONE]
- ✅ **Write the tuned plan back** in the customer's route schema:
  `planToRoutesCsv` emits order_no / vehicle / sequence / date (+ planned
  times), columns aligned to the `routes` canonical so it re-imports through the
  same onboarding pipeline (verified: a round-tripped routes.csv auto-maps all
  four fields). `planToHandoffJson` is a clean structured dispatch-plan document.
  `GET /api/plans/:id/routes.csv` + `/handoff.json`.
- ✅ Export menu reorganized: "For drivers" (route sheets, stops CSV) vs
  "Hand back to your system" (routes CSV, dispatch plan JSON).

### 5. Current-plan "issues" review panel  [DONE]
Not a persistent worklist (that would be SoR-ish): a review aid for *this* plan before
handoff. ✅ Built: an Issues dialog (TopBar "Issues · N" button, N = unassigned + hard
violations) listing unassigned orders (each with its inferred reason), hard constraint
violations (late / over-capacity), and soft advisories (tail-lift / oversize), each
click-to-locate. Reuses the mapper's violations + the new unassigned reasons.

### Lower priority / polish
✅ First-run/contextual help: a guided overlay (HelpOverlay, TopBar '?') annotating
each region on first run. Remaining: keyboard shortcuts + bulk actions; a
settings/preferences surface (units, default objective/budget, depot, cost params);
3L load visualization (the checker is design-only).

## Sequencing

1. **Drag-to-reassign** (now) -> 2. stop resequencing (precedence wiring) ->
3. scenario compare depth -> 4. explainability -> 5. outbound write-back.
Each is self-contained and demoable; none pulls the product toward a system of record.
