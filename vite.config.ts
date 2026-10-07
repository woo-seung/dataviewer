import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `vite build --mode single` → one self-contained HTML file (opens from disk, no server).
export default defineConfig(({ mode }) => ({
  base: './',
  worker: { format: 'es' },
  plugins: mode === 'single' ? [viteSingleFile()] : [],
  build: {
    chunkSizeWarningLimit: 6000,
    outDir: mode === 'single' ? 'dist-single' : 'dist',
  },
}));
