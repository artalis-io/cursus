import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// the backend is the thin app backend (scenarios, plans, jobs, and a proxy to Carta
// tiles + local glyphs). In dev we proxy same-origin asset paths to it so the
// reused Carta style's root-relative URLs ("/tiles.vector.json", "/tiles/...")
// resolve unchanged. Override with VITE_API_ORIGIN. No public CDNs at runtime:
// tiles come from backend/Carta, fonts are served locally from public/fonts.
const API = process.env.VITE_API_ORIGIN || 'http://localhost:8091';

// MapLibre requests one glyph PBF per 256-codepoint range on demand. For a range
// the font does not cover, the file genuinely does not exist and the correct
// answer is 404 -- MapLibre then omits those glyphs. Vite's dev server otherwise
// falls through to the SPA index.html with a 200, which MapLibre tries to parse
// as a protobuf ("Unimplemented type: 4"). This guard keeps dev faithful to how
// a static host serves the built site. Production needs no equivalent: a missing
// file 404s on its own. Copied from carta/maplibre-viewer/vite.config.ts.
function glyph404() {
  const fontsDir = fileURLToPath(new URL('./public/fonts/', import.meta.url));
  return {
    name: 'glyph-404',
    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: any) => {
        const url = decodeURIComponent((req.url || '').split('?')[0]);
        const m = url.match(/^\/fonts\/(.+\.pbf)$/);
        if (m && !existsSync(fontsDir + m[1])) { res.statusCode = 404; res.end(); return; }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), glyph404()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5179,
    proxy: {
      '/tiles.vector.json': { target: API, changeOrigin: true },
      '/tiles': { target: API, changeOrigin: true },
      '/api': { target: API, changeOrigin: true },
    },
  },
});

// Silence an unused import on some TS configs; path is kept available for
// future static-asset wiring without re-plumbing the import.
void path;
