import { defineConfig } from 'vite';

// Frontend of the Tauri desktop app (src-tauri). `npm run dev` alone serves the
// UI for browser tests against the engine bridge (?bridge=http://127.0.0.1:7878).
export default defineConfig({
  base: './',
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
