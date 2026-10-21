# Resizable workspace

On workspaces at least 1024 pixels wide, drag the dividers between Fleet/Map,
Map/Inspector and Map/Timeline. The existing sidebar collapse buttons remain.
The map toolbar's **Reset layout** button restores all three default dimensions;
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

Preferences are browser-local UI settings under `cursus.workspace-layout.v1`.
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
