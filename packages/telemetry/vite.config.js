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
  },
});