import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientRoot = resolve(appRoot, 'dist/client');
const indexHtml = await readFile(resolve(clientRoot, 'index.html'), 'utf8');
const entryMatch = indexHtml.match(/<script[^>]+src="([^"]+)"/u);
if (!entryMatch?.[1]) throw new Error('Production HTML does not reference a JavaScript entry.');

const entrySource = await readFile(resolve(clientRoot, entryMatch[1].replace(/^\//u, '')), 'utf8');
if (/data:(?:application|text)\/javascript/iu.test(entrySource)) {
  throw new Error('Production entry contains an inline JavaScript data URL, which violates the CSP.');
}
if (/\b(?:AIza[A-Za-z0-9_-]{30,}|AQ\.[A-Za-z0-9_-]{30,})\b/u.test(entrySource)) {
  throw new Error('Production entry contains a value shaped like a Gemini API key.');
}

const assetNames = await readdir(resolve(clientRoot, 'assets'));
const worklets = assetNames.filter((name) => /^audio-worklet-[A-Za-z0-9_-]+\.js$/u.test(name));
if (worklets.length !== 1) {
  throw new Error(`Expected one emitted AudioWorklet asset, found ${worklets.length}.`);
}
if (!entrySource.includes(`/assets/${worklets[0]}`)) {
  throw new Error('Production entry does not reference the emitted AudioWorklet asset.');
}

console.log(`Production bundle uses same-origin AudioWorklet asset: assets/${worklets[0]}`);

const pdfWorkers = assetNames.filter((name) => /^pdf\.worker\.min-[A-Za-z0-9_-]+\.mjs$/u.test(name));
if (pdfWorkers.length !== 1) throw new Error('Expected one emitted PDF worker.');
for (const prefix of ['pdf-preview-', 'docx-preview-']) {
  const chunk = assetNames.find((name) => name.startsWith(prefix) && name.endsWith('.js'));
  if (!chunk || !entrySource.includes(chunk)) throw new Error(`Missing lazy preview chunk: ${prefix}`);
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
