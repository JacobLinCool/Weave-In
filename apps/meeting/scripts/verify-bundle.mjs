import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientRoot = resolve(appRoot, 'dist/client');
const indexHtml = await readFile(resolve(clientRoot, 'index.html'), 'utf8');
const entryMatch = indexHtml.match(/<script[^>]+src="([^"]+)"/u);
if (!entryMatch?.[1]) throw new Error('Production HTML does not reference a JavaScript entry.');

const manifest = JSON.parse(await readFile(resolve(clientRoot, '.vite/manifest.json'), 'utf8'));
const entry = manifest['index.html'];
if (!entry?.isEntry || entry.file !== entryMatch[1].replace(/^\//u, '')) {
  throw new Error('Production HTML entry does not match the Vite manifest.');
}

const reachable = new Map();
const dynamicImports = new Set();
const checkedAssets = new Set();
async function visit(key) {
  if (reachable.has(key)) return;
  const chunk = manifest[key];
  if (!chunk?.file || !/\.m?js$/u.test(chunk.file)) throw new Error(`Missing JavaScript chunk in manifest: ${key}`);
  const source = await readFile(resolve(clientRoot, chunk.file), 'utf8');
  if (!source.length) throw new Error(`Empty production chunk: ${chunk.file}`);
  reachable.set(key, { chunk, source });
  for (const asset of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
    if (checkedAssets.has(asset)) continue;
    if (!(await stat(resolve(clientRoot, asset))).size) throw new Error(`Empty referenced asset: ${asset}`);
    checkedAssets.add(asset);
  }
  for (const dependency of chunk.imports ?? []) await visit(dependency);
  for (const dependency of chunk.dynamicImports ?? []) {
    dynamicImports.add(dependency);
    await visit(dependency);
  }
}
await visit('index.html');

// Preserve the entry checks when pages move behind lazy route imports. Deeper
// optional library features are outside the entry's existing CSP audit scope.
const routeChunks = new Set();
function includeStaticImports(key) {
  if (routeChunks.has(key)) return;
  routeChunks.add(key);
  for (const dependency of reachable.get(key).chunk.imports ?? []) includeStaticImports(dependency);
}
for (const key of ['index.html', ...(entry.dynamicImports ?? [])]) includeStaticImports(key);
for (const key of routeChunks) {
  const { chunk, source } = reachable.get(key);
  if (/data:(?:application|text)\/javascript/iu.test(source)) {
    throw new Error(`Production page chunk contains an inline JavaScript data URL, which violates the CSP: ${chunk.file}`);
  }
  if (/\b(?:AIza[A-Za-z0-9_-]{30,}|AQ\.[A-Za-z0-9_-]{30,})\b/u.test(source)) {
    throw new Error(`Production page chunk contains a value shaped like a Gemini API key: ${chunk.file}`);
  }
}
const reachableSource = [...reachable.values()].map(({ source }) => source).join('\n');

const assetNames = await readdir(resolve(clientRoot, 'assets'));
const worklets = assetNames.filter((name) => /^audio-worklet-[A-Za-z0-9_-]+\.js$/u.test(name));
if (worklets.length !== 1) {
  throw new Error(`Expected one emitted AudioWorklet asset, found ${worklets.length}.`);
}
if (!reachableSource.includes(`/assets/${worklets[0]}`)) {
  throw new Error('Production pages do not reference the emitted AudioWorklet asset.');
}

console.log(`Production bundle uses same-origin AudioWorklet asset: assets/${worklets[0]}`);

const pdfWorkers = assetNames.filter((name) => /^pdf\.worker\.min-[A-Za-z0-9_-]+\.mjs$/u.test(name));
if (pdfWorkers.length !== 1) throw new Error('Expected one emitted PDF worker.');
if (!reachableSource.includes(`/assets/${pdfWorkers[0]}`)) throw new Error('Production pages do not reference the emitted PDF worker.');
for (const key of ['src/pdf-preview.tsx', 'src/docx-preview.tsx']) {
  if (!reachable.has(key) || !dynamicImports.has(key) || !manifest[key].isDynamicEntry || routeChunks.has(key)) {
    throw new Error(`Missing lazy preview chunk: ${key}`);
  }
}
for (const asset of [
  'cmaps/Adobe-CNS1-UCS2.bcmap',
  'standard_fonts/LiberationSans-Regular.ttf',
  'wasm/openjpeg_nowasm_fallback.js',
  'wasm/jbig2_nowasm_fallback.js',
]) {
  if (!(await stat(resolve(clientRoot, 'pdfjs', asset))).size) throw new Error(`Empty PDF asset: ${asset}`);
}
console.log('Production bundle includes lazy document readers and same-origin PDF decoding assets.');
