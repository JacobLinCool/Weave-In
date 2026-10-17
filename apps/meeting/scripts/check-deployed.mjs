import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export class ProbeError extends Error {}

function approvedOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new ProbeError('INVALID_ORIGIN'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
    throw new ProbeError('INVALID_ORIGIN');
  }
  return url.origin;
}

async function boundedText(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw new ProbeError('EMPTY_RESPONSE');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ProbeError('RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function statusCheck(response) {
  if (response.status === 403 || response.status === 401) throw new ProbeError('PUBLIC_ROUTE_ACCESS_BLOCKED');
  if (response.status !== 200) throw new ProbeError('UNEXPECTED_HTTP_STATUS');
}

/** Verify the currently deployed static entry without requiring new health APIs. */
export async function checkPublicEntry({ origin, fetchImpl = fetch }) {
  origin = approvedOrigin(origin);
  try {
    const page = await fetchImpl(`${origin}/`, {
      method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
      signal: AbortSignal.timeout(10_000), headers: { Accept: 'text/html' },
    });
    statusCheck(page);
    if (page.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'text/html') {
      throw new ProbeError('LANDING_ROUTE_IS_NOT_HTML');
    }
    const html = await boundedText(page, 256 * 1024);
    if (!/<html(?:\s|>)/iu.test(html) || !/<script\b[^>]*\btype=["']module["']/iu.test(html)) {
      throw new ProbeError('LANDING_ENTRY_MISSING');
    }
    return { ok: true, mode: 'entry-only', checks: ['static-landing-entry'] };
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError('PUBLIC_PROBE_TRANSPORT_FAILED');
  }
}

/** Public GETs only: no room joins, credentials, provider requests or retries. */
export async function checkDeployed({ origin, commit, channel = 'production', fetchImpl = fetch }) {
  origin = approvedOrigin(origin);
  if (!/^[a-f0-9]{40}$/u.test(commit) || !['production', 'preview', 'development'].includes(channel)) {
    throw new ProbeError('INVALID_EXPECTED_BUILD');
  }
  const options = { method: 'GET', redirect: 'manual', credentials: 'omit',
    cache: 'no-store', signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' } };
  try {
    const health = await fetchImpl(`${origin}/healthz`, options);
    statusCheck(health);
    if (health.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      throw new ProbeError('HEALTH_ROUTE_IS_NOT_JSON');
    }
    let info;
    try { info = JSON.parse(await boundedText(health, 4096)); }
    catch (error) { if (error instanceof ProbeError) throw error; throw new ProbeError('INVALID_HEALTH_JSON'); }
    const fields = ['ok', 'service', 'source_commit', 'deployment_channel'];
    if (!info || typeof info !== 'object' || Object.keys(info).length !== fields.length
        || fields.some((field) => !Object.hasOwn(info, field))
        || info.ok !== true || info.service !== 'weave-in-meeting'
        || info.source_commit !== commit || info.deployment_channel !== channel) {
      throw new ProbeError('DEPLOYED_BUILD_MISMATCH');
    }
    await checkPublicEntry({ origin, fetchImpl });
    return { ok: true, source_commit: commit, deployment_channel: channel,
      checks: ['worker-liveness', 'exact-build-label', 'static-landing-entry'] };
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    // Fetch errors can include headers, addresses or response data. Suppress.
    throw new ProbeError('PUBLIC_PROBE_TRANSPORT_FAILED');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      origin: { type: 'string' }, commit: { type: 'string' }, channel: { type: 'string', default: 'production' },
      'entry-only': { type: 'boolean', default: false },
    } });
    if (values['entry-only'] && values.commit !== undefined) throw new ProbeError('INVALID_PROBE_ARGUMENTS');
    const result = values['entry-only'] ? await checkPublicEntry(values) : await checkDeployed(values);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof ProbeError ? error.message : 'INVALID_PROBE_ARGUMENTS');
    process.exitCode = 1;
  }
}
