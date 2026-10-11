import type { StyleSpecification } from 'maplibre-gl';

/*
 * Dispatch basemap: a subdued "Carta Quiet" palette, TUNED for contrast at the
 * country/regional zooms this tool uses over Hungary. (The carta/maplibre-viewer
 * original was validated at Monaco street zoom, where its near-white minor roads
 * read fine; over a whole country at z10-14 those white hairlines on ivory
 * vanished and the map looked empty. This variant gives minor roads a readable
 * casing and firms up buildings/landuse, while staying muted so the overlaid
 * delivery routes still dominate.) Glyphs are served locally (no CDN).
 */

const C = {
  ivory: '#f4f1e8',
  water: '#cfe2ef',
  waterLine: '#9fc4dd',
  waterSoft: '#b9d6e8',   // soft river line; visible on ivory, gentle against the fill
  forest: '#d6e0bf',
  park: '#dde7cc',
  grass: '#e0e9d0',
  residential: '#ece6da',
  commercial: '#ece4d8',
  industrial: '#e8e3d8',
  farmland: '#e9edd8',
  building: '#e6ddcd',
  buildingLine: '#c6bba2',
  rail: '#bbb2a3',
  boundary: '#c3b2de',
  casing: '#cdc3ae',      // readable taupe outline on ivory
  motorway: '#eeb25f',
  trunk: '#f2c585',
  primary: '#f4d099',
  secondary: '#f7dcac',
  minor: '#ffffff',       // white fill, made readable by its casing
  label: '#3f3b2f',
  labelHalo: '#f7f4ec',
  waterLabel: '#3f6178',
};

export function cartaStyle(): StyleSpecification {
  return {
    version: 8,
    name: 'Carta Dispatch',
    glyphs: '/fonts/{fontstack}/{range}.pbf',
    sources: {
      carta: { type: 'vector', url: '/tiles.vector.json' },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': C.ivory } },

      // --- Landuse (subdued fills, but readable) ---
      { id: 'landuse-forest', type: 'fill', source: 'carta', 'source-layer': 'landuse',
        filter: ['==', ['get', 'class'], 'forest'],
        paint: { 'fill-color': C.forest, 'fill-opacity': 0.85 } },
      { id: 'landuse-park', type: 'fill', source: 'carta', 'source-layer': 'landuse',
        filter: ['in', ['get', 'class'], ['literal', ['park', 'grass']]],
        paint: { 'fill-color': C.park, 'fill-opacity': 0.8 } },
      { id: 'landuse-farmland', type: 'fill', source: 'carta', 'source-layer': 'landuse',
        filter: ['==', ['get', 'class'], 'farmland'],
        paint: { 'fill-color': C.farmland, 'fill-opacity': 0.7 } },
      { id: 'landuse-residential', type: 'fill', source: 'carta', 'source-layer': 'landuse',
        filter: ['in', ['get', 'class'], ['literal', ['residential', 'commercial', 'industrial']]],
        paint: { 'fill-color': C.residential, 'fill-opacity': 0.6 } },

      // --- Water ---
      // Waterway centerlines are drawn FIRST, UNDER the fills. Wide rivers (the
      // Danube) have both a riverbank polygon and a waterway centerline; drawing
      // the line under the fill lets the polygon cover the centerline (no stray
      // line down the middle of a filled river), while narrow streams/rivers
      // with no polygon still read as lines. Geometry-type guards keep fills on
      // polygons and lines on linestrings.
      // Rivers/canals usually ALSO have a riverbank polygon; the centerline is
      // drawn in the fill colour so wherever it is not covered by the (narrow,
      // at low zoom) polygon it blends seamlessly instead of showing a darker
      // line down the river. Streams rarely have a polygon, so they keep a
      // slightly darker, readable blue.
      { id: 'water-line', type: 'line', source: 'carta', 'source-layer': 'water',
        filter: ['all', ['==', ['geometry-type'], 'LineString'],
          ['in', ['get', 'class'], ['literal', ['river', 'canal']]]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.waterSoft,
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.2, 14, 3.2] } },
      { id: 'water-stream', type: 'line', source: 'carta', 'source-layer': 'water',
        minzoom: 12,
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'class'], 'stream']],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.waterSoft,
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 1.6] } },
      // No fill-outline-color: on a clipped MVT polygon it draws a hard line
      // along the tile edge, and on a sub-pixel-wide river the two bank outlines
      // merge into a dark line down the water. The pale fill against ivory
      // defines the water edge on its own.
      { id: 'water-fill', type: 'fill', source: 'carta', 'source-layer': 'water',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': C.water } },

      // --- Buildings ---
      { id: 'buildings', type: 'fill', source: 'carta', 'source-layer': 'buildings',
        minzoom: 13,
        paint: { 'fill-color': C.building, 'fill-outline-color': C.buildingLine, 'fill-opacity': 0.85 } },

      // --- Railways ---
      { id: 'rail', type: 'line', source: 'carta', 'source-layer': 'railways',
        minzoom: 9,
        paint: { 'line-color': C.rail, 'line-dasharray': [3, 2],
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 16, 1.8] } },

      // --- Minor road casing (under the white fill, so minor roads read) ---
      { id: 'road-minor-casing', type: 'line', source: 'carta', 'source-layer': 'roads',
        minzoom: 11,
        filter: ['in', ['get', 'class'], ['literal', ['residential', 'service', 'tertiary', 'other']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.casing,
          'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 11, 1.2, 14, 3.0, 16, 5.6, 19, 13.0] } },

      // --- Major road casing (under fills) ---
      { id: 'road-casing', type: 'line', source: 'carta', 'source-layer': 'roads',
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.casing,
          'line-width': ['interpolate', ['exponential', 1.4], ['zoom'],
            6, 1.6, 10, 3.6, 14, 8.0, 18, 20.0] } },

      // --- Road fills by class ---
      { id: 'road-minor', type: 'line', source: 'carta', 'source-layer': 'roads',
        minzoom: 11,
        filter: ['in', ['get', 'class'], ['literal', ['residential', 'service', 'tertiary', 'other']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.minor,
          'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 11, 0.6, 14, 2.0, 16, 3.8, 19, 10.5] } },
      { id: 'road-secondary', type: 'line', source: 'carta', 'source-layer': 'roads',
        filter: ['==', ['get', 'class'], 'secondary'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.secondary,
          'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 8, 1.0, 12, 2.6, 16, 6.4] } },
      { id: 'road-primary', type: 'line', source: 'carta', 'source-layer': 'roads',
        filter: ['==', ['get', 'class'], 'primary'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.primary,
          'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 7, 1.2, 12, 3.4, 16, 8.4] } },
      { id: 'road-trunk', type: 'line', source: 'carta', 'source-layer': 'roads',
        filter: ['==', ['get', 'class'], 'trunk'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.trunk,
          'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 6, 1.2, 12, 3.8, 16, 9.4] } },
      { id: 'road-motorway', type: 'line', source: 'carta', 'source-layer': 'roads',
        filter: ['==', ['get', 'class'], 'motorway'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.motorway,
          'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 5, 1.4, 12, 4.4, 16, 11.5] } },

      // --- Boundaries ---
      { id: 'boundary', type: 'line', source: 'carta', 'source-layer': 'boundaries',
        paint: { 'line-color': C.boundary, 'line-dasharray': [4, 2], 'line-opacity': 0.6,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 10, 1.4] } },

      // --- Road name labels ---
      // Major road names appear from regional zoom (z11); the full set from z13.
      // (The handoff is clean: the major tier stops at z13 where the all-roads
      // tier begins.) Without this, a dispatcher at regional zoom saw no road
      // names at all.
      { id: 'road-labels-major', type: 'symbol', source: 'carta', 'source-layer': 'roads',
        minzoom: 11, maxzoom: 13,
        filter: ['all', ['has', 'name'],
          ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary']]]],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'name'],
          'text-font': ['IBM Plex Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 9.5, 13, 11.5],
        },
        paint: { 'text-color': C.label, 'text-halo-color': C.labelHalo, 'text-halo-width': 1.3 } },
      { id: 'road-labels', type: 'symbol', source: 'carta', 'source-layer': 'roads',
        minzoom: 13,
        filter: ['has', 'name'],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'name'],
          'text-font': ['IBM Plex Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 18, 13],
        },
        paint: { 'text-color': C.label, 'text-halo-color': C.labelHalo, 'text-halo-width': 1.2 } },

      // --- Place labels (from the labels layer) ---
      { id: 'place-labels', type: 'symbol', source: 'carta', 'source-layer': 'labels',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['IBM Plex Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['get', 'rank'],
            0, 11, 5, 14, 20, 20],
          'text-anchor': 'center',
          'text-max-width': 7,
          'symbol-sort-key': ['-', 100, ['coalesce', ['get', 'rank'], 0]],
        },
        paint: { 'text-color': C.label, 'text-halo-color': C.labelHalo, 'text-halo-width': 1.6 } },
    ],
  } as StyleSpecification;
}

/** Warm ivory background, exported so panels can match the basemap. */
export const CARTA_IVORY = C.ivory;
