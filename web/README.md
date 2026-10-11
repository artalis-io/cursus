# Cursus Web

A desktop-first transportation-planning and dispatch workspace SPA for Cursus. This is
the **scaffold**: build tooling, theme tokens, and a static layout skeleton
driven by a hand-authored sample plan. Real interactions and polish are built on
top of this foundation.

## Stack

- React 18 + TypeScript + Vite
- Tailwind CSS v3 + shadcn/ui (CSS-variables theming)
- react-map-gl v7 (`react-map-gl/maplibre`) + maplibre-gl v4
- `motion` (Framer Motion v11) for transitions, gated on `prefers-reduced-motion`
- Inter via `@fontsource/inter` (local, no CDN), tabular numerals enabled

The map reuses the **Carta Quiet** basemap style, copied verbatim from
`carta/maplibre-viewer/src/style.ts` into `src/map/cartaStyle.ts`. IBM Plex SDF
glyphs are copied into `public/fonts/` so labels render.

## Prerequisites

- Node 20 (`source ~/.nvm/nvm.sh && nvm use 20`)

## Install

```bash
npm install
```

## Develop

```bash
npm run dev
```

Serves on **http://localhost:5179**. The app loads `public/sample-plan.json`, so
it renders without a backend.

The dev server proxies same-origin asset/API paths to `server` (the app
backend), so the reused Carta style's root-relative URLs resolve unmodified:

| Path | Proxied to |
|---|---|
| `/tiles.vector.json`, `/tiles/*` | the backend (`VITE_API_ORIGIN`) → Carta |
| `/api/*` | Backend |
| `/fonts/*` | Served locally from `public/fonts/` (404 guard on missing glyph ranges) |

Override the backend origin:

```bash
VITE_API_ORIGIN=http://localhost:8091 npm run dev
```

Without a running backend/Carta, the basemap tiles and labels will 404 (the sample
routes, depot marker, panels, timeline, and inspector still render); start the backend +
Carta to see the full basemap.

## Build

```bash
npm run build
```

Runs `tsc -b` (type-check) then `vite build`, emitting `dist/`.

## Layout

```
Top bar (graphite): wordmark · day selector · status chip · Optimize/Save/Export
KPI strip: served/total · vehicles · distance · solve time · stops
┌───────────┬──────────────────────────────┬─────────────┐
│ Fleet     │ Map (Carta Quiet + routes)   │ Inspector   │
│ (vehicles,│                              │ (Details /  │
│  search,  ├──────────────────────────────┤  Load tabs) │
│  unassig.)│ Timeline (SVG trip blocks)   │             │
└───────────┴──────────────────────────────┴─────────────┘
```

Left and right panels collapse via the floating toggles over the map.

## Sample data

`public/sample-plan.json` is a hand-authored `Plan` (see
`docs/data-api-mapping.md` and `src/types.ts`). Clearly marked as sample
in-app. Its route geometries are faked with a few coordinates near
the depot area/Budapest and do **not** follow real roads — real geometry comes from
Velo via the backend, cached per plan.
```
```

## Notes for real wiring

- Replace the `fetch('/sample-plan.json')` in `src/App.tsx` with
  `GET /api/plans/:id`. Honor `scenarioRevision` for stale-job safety.
- `src/map/cartaStyle.ts` is a verbatim copy; keep it in sync with the Carta
  viewer rather than editing locally.
