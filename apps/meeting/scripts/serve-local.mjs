import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_getMiniflareWorkerOptions } from 'wrangler';

// Serve a completed build without Wrangler's development ProxyWorker, which can
// terminate the whole process on a dropped HTTP connection while WebSockets are open.
const { values } = parseArgs({ options: {
  config: { type: 'string', default: 'dist/weave_in_meeting/wrangler.json' },
  port: { type: 'string', default: '8787' },
  origin: { type: 'string' },
  persist: { type: 'string', default: '.wrangler/preview-state' },
} });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
const origin = new URL(values.origin ?? `http://127.0.0.1:${port}`);
if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
  throw new Error('origin must be an HTTP(S) origin without a path or credentials.');
}
const config = resolve(values.config);
const { workerOptions, main, externalWorkers } = unstable_getMiniflareWorkerOptions(config);
if (!main) throw new Error('Build the meeting app before starting the local preview.');
// Vite emits a single bundled worker module; no source module discovery is needed.
const { modulesRules, ...builtWorkerOptions } = workerOptions;
const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port, upstream: origin.origin,
  // Keep the URL's externally visible HTTPS origin so the Worker's same-origin
  // WebSocket and token checks also apply behind a loopback TLS reverse proxy.
  defaultPersistRoot: resolve(values.persist),
  workers: [{ ...builtWorkerOptions, name: 'weave-in-meeting', modules: [{ type: 'ESModule', path: main }] }, ...externalWorkers],
}));
await runtime.ready;
console.log(`Weave In local preview ready: ${origin.origin} (listening on 127.0.0.1:${port})`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await runtime.dispose();
  process.exit(0);
});
