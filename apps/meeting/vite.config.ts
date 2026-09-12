import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
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
  ],
});
