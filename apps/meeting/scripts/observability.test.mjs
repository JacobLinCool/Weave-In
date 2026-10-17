import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMetadata } from './build-metadata.mjs';
import { checkDeployed, checkPublicEntry, ProbeError } from './check-deployed.mjs';
import { healthResponse, publicBuildInfo } from '../worker/health.ts';

const SHA = 'a'.repeat(40);
const SECRET = 'synthetic-do-not-expose-meeting-or-credential';
const LABEL = { ok: true, service: 'weave-in-meeting', source_commit: SHA, deployment_channel: 'production' };
const args = { origin: 'https://weave.nycu.ai', commit: SHA };
const landing = () => new Response('<!doctype html><html><head><script type="module" src="/assets/main.js"></script></head></html>', {
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
});
const health = (body = LABEL, init = {}) => Response.json(body, init);
const sequence = (...responses) => {
  const calls = [];
  const fetchImpl = async (...call) => {
    calls.push(call);
    if (!responses.length) throw new Error('Unexpected extra request');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetchImpl, calls };
};

test('only two allowlisted build environment fields are read', () => {
  const values = new Proxy({ WEAVE_SOURCE_COMMIT: SHA, WEAVE_DEPLOYMENT_CHANNEL: 'production' }, {
    get(target, key) {
      assert.ok(['WEAVE_SOURCE_COMMIT', 'WEAVE_DEPLOYMENT_CHANNEL'].includes(key));
      return target[key];
    },
    ownKeys() { throw new Error('Must not enumerate environment'); },
  });
  assert.deepEqual(buildMetadata(values), { commit: SHA, channel: 'production' });
});

test('unlabelled local builds cannot claim a deployed commit', () => {
  assert.deepEqual(buildMetadata({}), { commit: '', channel: 'development' });
  assert.equal(publicBuildInfo('', 'development').source_commit, null);
});

test('invalid or missing production labels stop the build', () => {
  for (const env of [{ WEAVE_SOURCE_COMMIT: SECRET }, { WEAVE_SOURCE_COMMIT: 'abc123' },
    { WEAVE_SOURCE_COMMIT: 'A'.repeat(40) }, { WEAVE_DEPLOYMENT_CHANNEL: SECRET },
    { WEAVE_DEPLOYMENT_CHANNEL: 'production' }]) {
    assert.throws(() => buildMetadata(env), (error) => !error.message.includes(SECRET));
  }
});

test('public projection rejects arbitrary objects and labels', () => {
  const hostile = { toString() { throw new Error(SECRET); } };
  assert.deepEqual(publicBuildInfo(hostile, hostile), {
    service: 'weave-in-meeting', source_commit: null, deployment_channel: 'unknown',
  });
  assert.equal(publicBuildInfo(SHA, 'preview').deployment_channel, 'preview');
});

test('GET health is exact credential-free no-store JSON and does not echo requests', async () => {
  const response = healthResponse(new Request(`https://weave.nycu.ai/healthz?room=${SECRET}`, {
    headers: { Authorization: SECRET, 'X-Private-Transcript': SECRET },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(await response.json(), {
    ok: true, service: 'weave-in-meeting', source_commit: null, deployment_channel: 'unknown',
  });
});

test('HEAD health has no body; mutation methods return405', async () => {
  const head = healthResponse(new Request('https://weave.nycu.ai/healthz', { method: 'HEAD' }));
  assert.equal(await head.text(), '');
  assert.match(head.headers.get('Content-Type'), /application\/json/u);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = healthResponse(new Request('https://weave.nycu.ai/healthz', { method }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'GET, HEAD');
  }
});

test('smoke requires exact SHA/channel and a real static HTML entry', async () => {
  const mock = sequence(health(), landing());
  const result = await checkDeployed({ ...args, ...mock });
  assert.equal(result.ok, true);
  assert.deepEqual(mock.calls.map(([url]) => url), ['https://weave.nycu.ai/healthz', 'https://weave.nycu.ai/']);
  for (const [, options] of mock.calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(options.headers), ['Accept']);
    assert.ok(!JSON.stringify(options).includes(SECRET));
  }
});

test('SPA fallback200 cannot pass the health check', async () => {
  const mock = sequence(landing());
  await assert.rejects(checkDeployed({ ...args, ...mock }), /HEALTH_ROUTE_IS_NOT_JSON/u);
  assert.equal(mock.calls.length, 1);
});

test('access blocks are reported distinctly without reading private response bodies', async () => {
  for (const status of [401, 403]) {
    const mock = sequence(new Response(SECRET, { status }));
    await assert.rejects(checkDeployed({ ...args, ...mock }), /^Error: PUBLIC_ROUTE_ACCESS_BLOCKED$/u);
    assert.equal(mock.calls.length, 1);
  }
});

test('redirects and error statuses stop without following or retries', async () => {
  for (const status of [301, 302, 307, 308, 404, 500, 503]) {
    const mock = sequence(new Response(SECRET, { status, headers: { Location: 'https://elsewhere.invalid/' } }));
    await assert.rejects(checkDeployed({ ...args, ...mock }), /UNEXPECTED_HTTP_STATUS/u);
    assert.equal(mock.calls.length, 1);
  }
});

test('wrong/unknown build and extra private fields are rejected', async () => {
  for (const body of [{ ...LABEL, source_commit: 'b'.repeat(40) }, { ...LABEL, source_commit: null },
    { ...LABEL, deployment_channel: 'preview' }, { ...LABEL, transcript: SECRET }, { ...LABEL, ok: false },
    null, true, []]) {
    const mock = sequence(health(body));
    await assert.rejects(checkDeployed({ ...args, ...mock }), /DEPLOYED_BUILD_MISMATCH/u);
    assert.equal(mock.calls.length, 1);
  }
});

test('malformed JSON and mismatched media types stop without body output', async () => {
  for (const type of ['application/json', 'application/jsonp']) {
    const mock = sequence(new Response(SECRET, { headers: { 'Content-Type': type } }));
    await assert.rejects(checkDeployed({ ...args, ...mock }), (error) => {
      assert.ok(error instanceof ProbeError);
      return !error.message.includes(SECRET);
    });
  }
});

test('health and static responses have separate byte limits', async () => {
  const largeHealth = sequence(new Response(' '.repeat(4097), { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(checkDeployed({ ...args, ...largeHealth }), /RESPONSE_TOO_LARGE/u);
  const largePage = sequence(health(), new Response(' '.repeat(256 * 1024 + 1), { headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(checkDeployed({ ...args, ...largePage }), /RESPONSE_TOO_LARGE/u);
});

test('missing landing entry and JSON masquerading as landing fail', async () => {
  for (const response of [new Response('<html>Unavailable</html>', { headers: { 'Content-Type': 'text/html' } }), health()]) {
    const mock = sequence(health(), response);
    await assert.rejects(checkDeployed({ ...args, ...mock }), /LANDING_(ENTRY_MISSING|ROUTE_IS_NOT_HTML)/u);
  }
});

test('timeouts or network errors are sanitized and never retried', async () => {
  const mock = sequence(new Error(SECRET));
  await assert.rejects(checkDeployed({ ...args, ...mock }), /^Error: PUBLIC_PROBE_TRANSPORT_FAILED$/u);
  assert.equal(mock.calls.length, 1);
});

test('origin validation rejects credentials/path/unsafe scheme before any fetch', async () => {
  for (const origin of ['https://user:password@example.com', 'https://example.com/path',
    'https://example.com?token=secret', 'http://example.com', 'file:///etc/passwd', 'not a URL']) {
    let called = false;
    await assert.rejects(checkDeployed({ ...args, origin, fetchImpl: async () => { called = true; } }), /INVALID_ORIGIN/u);
    assert.equal(called, false);
  }
});

test('loopback preview checks use the expected preview channel', async () => {
  const mock = sequence(health({ ...LABEL, deployment_channel: 'preview' }), landing());
  const result = await checkDeployed({ origin: 'http://127.0.0.1:8787', commit: SHA, channel: 'preview', ...mock });
  assert.equal(result.deployment_channel, 'preview');
});

test('entry-only preflight makes one anonymous GET to root and never requires health', async () => {
  const mock = sequence(landing());
  const result = await checkPublicEntry({ origin: args.origin, ...mock });
  assert.deepEqual(result, { ok: true, mode: 'entry-only', checks: ['static-landing-entry'] });
  assert.equal(mock.calls.length, 1);
  const [url, options] = mock.calls[0];
  assert.equal(url, 'https://weave.nycu.ai/');
  assert.equal(options.method, 'GET');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'manual');
  assert.deepEqual(options.headers, { Accept: 'text/html' });
  assert.ok(options.signal instanceof AbortSignal);
  assert.ok(!Object.hasOwn(result, 'source_commit'));
});

test('entry-only401/403 and redirects fail without health requests or retries', async () => {
  for (const status of [401, 403, 301, 302, 307, 308]) {
    const mock = sequence(new Response(SECRET, { status, headers: { Location: 'https://elsewhere.invalid' } }));
    await assert.rejects(checkPublicEntry({ origin: args.origin, ...mock }),
      status === 401 || status === 403 ? /PUBLIC_ROUTE_ACCESS_BLOCKED/u : /UNEXPECTED_HTTP_STATUS/u);
    assert.equal(mock.calls.length, 1);
  }
});

test('entry-only rejects oversize, non-HTML and missing static entries', async () => {
  for (const [response, code] of [
    [new Response('x'.repeat(256 * 1024 + 1), { headers: { 'Content-Type': 'text/html' } }), 'RESPONSE_TOO_LARGE'],
    [health(), 'LANDING_ROUTE_IS_NOT_HTML'],
    [new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }), 'LANDING_ENTRY_MISSING'],
  ]) {
    const mock = sequence(response);
    await assert.rejects(checkPublicEntry({ origin: args.origin, ...mock }), new RegExp(code, 'u'));
    assert.equal(mock.calls.length, 1);
  }
});

test('entry-only transport errors remain sanitized', async () => {
  const mock = sequence(new Error(SECRET));
  await assert.rejects(checkPublicEntry({ origin: args.origin, ...mock }), /^Error: PUBLIC_PROBE_TRANSPORT_FAILED$/u);
  assert.equal(mock.calls.length, 1);
});

test('entry-only CLI checks only a synthetic local root and cannot accept a build claim', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization,
      cookie: request.headers.cookie });
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<html><script type="module" src="/assets/main.js"></script></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const run = (extra) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./check-deployed.mjs', import.meta.url)),
        '--origin', origin, '--entry-only', ...extra], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
      let stdout = '', stderr = '';
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    const valid = await run([]);
    assert.equal(valid.code, 0);
    assert.equal(JSON.parse(valid.stdout).mode, 'entry-only');
    assert.equal(valid.stderr, '');
    assert.deepEqual(requests, [{ method: 'GET', path: '/', authorization: undefined, cookie: undefined }]);
    const mixed = await run(['--commit', SHA]);
    assert.equal(mixed.code, 1);
    assert.equal(mixed.stderr.trim(), 'INVALID_PROBE_ARGUMENTS');
    assert.equal(requests.length, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
