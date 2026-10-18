import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('public build liveness', () => {
  it('routes health to JSON before assets/providers/rooms', async () => {
    const response = await SELF.fetch('https://weave.nycu.ai/healthz');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      ok: true, service: 'weave-in-meeting', source_commit: null, deployment_channel: 'unknown',
    });
  });

  it('supports body-free HEAD and rejects write methods', async () => {
    const head = await SELF.fetch('https://weave.nycu.ai/healthz', { method: 'HEAD' });
    expect(await head.text()).toBe('');
    const post = await SELF.fetch('https://weave.nycu.ai/healthz', { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('Allow')).toBe('GET, HEAD');
  });
});
