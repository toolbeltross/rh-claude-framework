import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_PORT = process.env.RH_TELEMETRY_PORT || 7890;

// Dev-only: Vite serves `index.html` (the v1 entry) at `/` by default, so the
// v2 dev server on :5174 would render v1 unless you knew to hit /index.v2.html.
// Rewrite the bare root / index.html requests to the v2 entry so `/` is v2 in dev.
// (The production build already uses index.v2.html as its rollup input.)
const serveV2AtRoot = {
  name: 'serve-v2-at-root',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/' || req.url === '/index.html') req.url = '/index.v2.html';
      next();
    });
  },
};

export default defineConfig({
  plugins: [serveV2AtRoot, react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/api': `http://localhost:${API_PORT}`,
      '/ws': {
        target: `ws://localhost:${API_PORT}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist-v2',
    rollupOptions: {
      input: 'index.v2.html',
      output: {
        // Split the charting stack (recharts + its d3 / victory-vendor deps) into
        // a dedicated chunk so the main bundle stays under the 500 kB warning and
        // the chart vendor code caches independently of app code.
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](recharts|recharts-scale|victory-vendor|d3-|internmap)/.test(id)) {
            return 'recharts';
          }
        },
      },
    },
  },
});
