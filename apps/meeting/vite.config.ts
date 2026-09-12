import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [react(), cloudflare(), viteStaticCopy({
    targets: ['cmaps', 'standard_fonts', 'wasm'].map((directory) => ({
      src: `node_modules/pdfjs-dist/${directory}`,
      dest: 'pdfjs',
      rename: { stripBase: 2 },
    })),
  })],
});
