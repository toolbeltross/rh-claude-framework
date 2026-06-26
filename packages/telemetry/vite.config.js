import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_PORT = process.env.RH_TELEMETRY_PORT || 7890;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': `http://localhost:${API_PORT}`,
      '/ws': {
        target: `ws://localhost:${API_PORT}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
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