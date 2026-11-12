import { defineConfig } from 'vite';

// Relative base so the build works under a GitHub Pages sub-path and on Vercel.
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  worker: { format: 'es' },
});
