# Workspace design prototype

Open `workflow-workspace.html` directly in a browser. It is self-contained and
works offline; no server, credentials, customer files or application image are
needed. Example state and role selectors are prototype controls, not Cursus
features. All operational buttons are explanatory placeholders.

The [proposal](../workflow-workspace-design.md) defines the workflow, current
component mapping, permission and state invariants, and staged implementation.
The schematic map and metrics are synthetic. The typography uses the existing
font family with a system fallback; no remote fonts or map assets are requested.

To check and capture the design using the repository's existing Playwright
installation and an installed compatible Chromium:

```sh
node docs/mockups/check-workflow.cjs /tmp/cursus-workspace-design
```

If Chromium is installed outside Playwright's default path, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to that executable. The helper checks 126
language/role/state/view combinations, six narrow-screen views, persistent
warnings, role affordances, the ordinary desktop chrome height budget, and the
absence of JavaScript errors or HTTP requests. It writes 13 screenshots and
`report.json` to the selected output directory.

These are design-artifact checks only. They do not exercise Cursus APIs, native
solves or production, and do not replace the application regression requirements
in the proposal. No application source or deployment configuration is changed.
