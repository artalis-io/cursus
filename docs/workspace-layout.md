# Resizable workspace

On workspaces at least 1024 pixels wide, drag the dividers between Fleet/Map,
Map/Inspector and Map/Timeline. The existing sidebar collapse buttons remain.
The map toolbar also independently collapses/restores the KPI bar and timeline.
Its five controls form a cross: KPI above, Fleet left, Reset layout centre,
Inspector right and Timeline below. Arrows reverse when a panel is hidden.
The centre remains available on narrow screens; it resets layout, not data or
scenario edits. Empty corners allow pointer interaction with the map beneath.
Their controls remain on the map when the panels are hidden, expose expanded
state to assistive technology, and support keyboard activation in English/Hungarian.
Collapsing the timeline stops playback and clears its map clock. Its preferred
expanded height is retained, and no invisible timeline divider remains.
The map toolbar's **Reset layout** button restores KPI/timeline visibility and all three default dimensions;
double-clicking a divider resets just its panel.

Focusable separators support arrow keys (10 pixels), Shift+arrow (40 pixels),
Home/End (minimum/maximum), and Escape to cancel a pointer drag. Inspector and
timeline controls follow the divider's direction: Left grows the inspector,
Up grows the timeline. Labels and instructions are available in English/Hungarian.

Fleet defaults to 310px (240–520), Inspector 340px (260–560), Timeline 192px
(120–360 when space permits). Desktop fitting preserves at least 320px map
width and 120px height when the workspace has room. Short windows or an expanded
readiness panel shrink the timeline further instead of overflowing the viewport.
Below 1024px, dividers are absent and the previous fixed panel sizes remain;
the saved desktop preferences are not overwritten by viewport fitting/collapse.
An explicit sidebar resize in a constrained viewport anchors the other sidebar
at its currently visible width so the divider follows the gesture predictably.

Preferences are browser-local UI settings under `cursus.workspace-layout.v1`.
KPI/timeline visibility is stored separately under `cursus.workspace-visibility.v1`
as versioned booleans; missing/invalid settings default to both visible.
They contain only a format version and three dimensions, not tenant/user IDs,
emails or plan data. They are not shared server state or cross-device settings.
Corrupted, non-finite or out-of-range values are sanitized. Storage denial or
quota exhaustion does not prevent using the workspace; persistence is best-effort.

All roles can adjust their own layout. Resize gestures use pointer capture and
a temporary interaction shield, not route drag-and-drop or solver commands.
No backend, permission, database, geographic asset or deployment changes.

Regression tests cover viewport fitting, persistence validation, pointer and
keyboard resizing, cancel/reset/reload, collapse/restore, narrow screens,
readiness expansion, unavailable storage and zero planning writes during resize.
Run the full isolated Docker acceptance suite with `python3 deploy/acceptance.py`.
