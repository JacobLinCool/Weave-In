import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      adapter: 'src/adapter.ts',
    },
    clean: true,
    dts: false,
    format: ['esm'],
    minify: false,
    platform: 'browser',
    sourcemap: true,
    splitting: false,
    target: 'es2024',
    treeshake: true,
  },
  {
    entry: { 'audio-worklet': 'src/audio-worklet.ts' },
    dts: false,
    format: ['esm'],
    minify: true,
    platform: 'browser',
    sourcemap: false,
    target: 'es2022',
  },
]);
