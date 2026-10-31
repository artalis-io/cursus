# Planning interaction polish

This pass refines existing planning operations. It does not change authorization,
solver parameters, constraints, publication, or API/persistence contracts.

## Findings and changes

| Finding | Correction |
|---|---|
| Expanded vehicles can highlight the same trip index even when only one vehicle is selected. | Selection is scoped to the vehicle and trip together. |
| Fleet vehicle headers are clickable divs without keyboard activation. | Native buttons with visible focus and selected state. |
| Map/timeline selection can leave the fleet collapsed, filtered, or out of view. | A shared selection trail, automatic expansion for selected trips/stops, and explicit **Show in fleet**. This clears only personal filters and focuses/reveals the exact item. It never edits the plan or steals focus on ordinary selection. |
| Delivery references can repeat; sequence numbers can change. | Shared context uses existing request/plan identity resolvers. Duplicate references show the delivery ID. Stale, ambiguous or missing deliveries produce no substitute context or actions. |
| Unassigned markers are displayed but not selectable. | Clicks resolve the same unassigned identity as the fleet. Selecting an unassigned order centers/highlights its coordinates when known. Missing coordinates do not invent a position. |
| Order actions follow long shipment detail; vehicle actions are separated from the selected vehicle. | Assignment actions precede shipment detail; vehicle exclusion/locking is next to the vehicle summary. Unverified fleet entries remain inspectable without mutation controls. |
| Apply can sound like optimization or approval. | **Calculate preview** validates without saving. **Save manual change** publishes a new draft without running the optimizer. **Replan** starts optimization and returns a candidate; choosing it does not approve it. |

## State and selection contract

- Fleet, map caption/ring and inspector refer to the same selected delivery.
- Inspector breadcrumbs navigate to vehicle/trip parents; Back/Forward remain available.
  Re-selecting the same delivery through another surface does not add a duplicate history entry.
  Selecting a different item opens its Details tab instead of leaving its actions hidden behind Load.
- Saved plan metrics remain authoritative while scenario instructions are staged.
  The inspector labels **Saved plan** and **Instructions staged for Replan** separately.
  Staged scenario instructions may already be persisted; they are not a newly computed plan.
- A manual preview is explicitly **not saved**. Saving remains the existing fenced,
  idempotent publication operation with a new plan revision and audited assignment origin.
- Optimizer candidates remain distinct from the displayed selected plan and need explicit
  adoption. Existing coverage acknowledgement and approval guards remain unchanged.
- Reviewer selection, filters, breadcrumbs and inspection are view-only. Editing
  remains governed by existing permissions in the UI and API.
- Reveal requests belong to the current plan/selection and cannot focus a later selection.
- Resizing, timeline controls and all six persistent KPIs remain available.
- The inspector body scrolls as a whole when viewport height is limited; Back/Forward
  and Close remain outside that scroll area. Map overlays are clipped to the map
  instead of intercepting inspector actions when the map column is narrow. Both
  panels have their own Close control, reachable even when the map is too narrow
  for floating controls. A deliberate selection opens the inspector; on narrow
  screens it closes the fleet to make room, and clearing selection returns to the map.

## Validation

Use synthetic two-instance acceptance for actual preview/save/replan, permissions,
selection identity, duplicate references, shared trip indexes, filter recovery,
keyboard interaction, EN/HU, bounded layouts, and no planning writes from navigation.
Use the existing local Gyermelyi fallback for a read-only visual walkthrough. Keep
all customer screenshots and walkthrough evidence outside Git. Record executed
results in the PR; do not infer production behavior from screenshots alone.

Production deployment is separate from local visual review.
