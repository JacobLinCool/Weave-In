import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const target = new URL('public/excalidraw/fonts/', root);
mkdirSync(target, { recursive:true });
cpSync(fileURLToPath(new URL('node_modules/@excalidraw/excalidraw/dist/prod/fonts/', root)), fileURLToPath(target), { recursive:true });
