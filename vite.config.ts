import { defineConfig } from 'vite';

// The engine runs in a module worker as WebAssembly (`npm run wasm` builds it
// into src/wasm/). base './' lets the build be served from any sub-path
// (GitHub Pages).
export default defineConfig({
  base: './',
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
