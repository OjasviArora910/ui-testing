import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.QA_API_URL ?? 'http://127.0.0.1:4000';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': { target: api, changeOrigin: false } } },
});
