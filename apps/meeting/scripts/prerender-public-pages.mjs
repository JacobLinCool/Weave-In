import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

// Writes the public pages' markup into the built app shell. `/` keeps index.html;
// `/about` gets about.html, which the asset binding serves for that path.
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientRoot = resolve(appRoot, 'dist/client');
const shell = await readFile(resolve(clientRoot, 'index.html'), 'utf8');
const root = '<div id="root"></div>';
if (shell.split(root).length !== 2) throw new Error('Production HTML must contain exactly one empty application root.');

const { module } = await runnerImport('/src/prerender.tsx', { root: appRoot, configFile: false, logLevel: 'warn' });
const pages = module.renderPublicPages();
for (const [name, markup] of Object.entries(pages)) {
  if (!/<h1[\s>]/u.test(markup)) throw new Error(`Prerendered ${name} page has no heading.`);
}
const withMarkup = (markup) => shell.replace(root, () => `<div id="root">${markup}</div>`);
await writeFile(resolve(clientRoot, 'index.html'), withMarkup(pages.landing));
await writeFile(resolve(clientRoot, 'about.html'), withMarkup(pages.about));
console.log('Prerendered public pages: index.html, about.html');
