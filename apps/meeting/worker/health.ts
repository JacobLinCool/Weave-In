// Vite replaces these public build labels. Unlabelled dev/test builds stay
// explicitly unknown; never infer a deployed commit from a directory name.
declare const __WEAVE_SOURCE_COMMIT__: string | undefined;
declare const __WEAVE_DEPLOYMENT_CHANNEL__: string | undefined;

export function publicBuildInfo(commit: unknown, channel: unknown) {
  return {
    service: 'weave-in-meeting',
    source_commit: typeof commit === 'string' && /^[a-f0-9]{40}$/u.test(commit) ? commit : null,
    deployment_channel: typeof channel === 'string' && ['production', 'preview', 'development'].includes(channel)
      ? channel as 'production' | 'preview' | 'development' : 'unknown',
  };
}

export function healthResponse(request: Request): Response {
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return Response.json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, {
      status: 405, headers: { ...headers, Allow: 'GET, HEAD' },
    });
  }
  const info = publicBuildInfo(
    typeof __WEAVE_SOURCE_COMMIT__ === 'string' ? __WEAVE_SOURCE_COMMIT__ : undefined,
    typeof __WEAVE_DEPLOYMENT_CHANNEL__ === 'string' ? __WEAVE_DEPLOYMENT_CHANNEL__ : undefined,
  );
  const response = Response.json({ ok: true, ...info }, { headers });
  return request.method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers }) : response;
}
