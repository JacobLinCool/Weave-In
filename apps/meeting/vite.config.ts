import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  build: { manifest: true },
  plugins: [
    {
      name: 'remove-excalidraw-hosted-demo-config',
      enforce: 'pre',
      apply: 'build',
      transform(code, id) {
        if (!id.includes('/@excalidraw/excalidraw/dist/') || !code.includes('VITE_APP_FIREBASE_CONFIG')) return null;
        // Room data uses our WebRTC transport; the upstream demo's Firebase config is unused.
        return { code: code.replace(/VITE_APP_FIREBASE_CONFIG\s*:\s*'[^']*'/gu, "VITE_APP_FIREBASE_CONFIG:'{}'"), map: null };
      },
    },
    react(),
    cloudflare(),
    viteStaticCopy({
      targets: ['cmaps', 'standard_fonts', 'wasm'].map((directory) => ({
        src: `node_modules/pdfjs-dist/${directory}`,
        dest: 'pdfjs',
        rename: { stripBase: 2 },
      })),
    }),
  ],
});
