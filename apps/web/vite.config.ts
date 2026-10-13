import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = 'http://localhost:3001';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: Object.fromEntries(['/api', '/hsk', '/fof', '/csh', '/oauth'].map((p) => [p, { target: api, changeOrigin: true }])),
  },
});
