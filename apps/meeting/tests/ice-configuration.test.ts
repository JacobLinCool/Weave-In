import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingIceConfiguration } from '../src/ice-configuration';

const HOUR = 3600000;
const servers = [{ urls: ['turn:relay.test:3478?transport=udp', 'turns:relay.test:443?transport=tcp'], username: 'short-lived', credential: 'test-credential' }];
const response = (expiresAt = Date.now() + HOUR) => Response.json({ ok: true, iceServers: servers, expiresAt });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('meeting relay credential lifecycle', () => {
  it('deduplicates concurrent provisioning and caches valid credentials for the meeting', async () => {
    const fetch = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetch);
    const update = vi.fn();
    const ice = new MeetingIceConfiguration(update, vi.fn());
    const [first, second] = await Promise.all([ice.get(), ice.get()]);
    expect(first).toBe(second);
    expect(await ice.get()).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/ice-servers', expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: expect.any(AbortSignal) }));
    expect(update).toHaveBeenCalledTimes(1);
    ice.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renews before expiry and publishes the replacement configuration', async () => {
    const fetch = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetch);
    const update = vi.fn();
    const ice = new MeetingIceConfiguration(update, vi.fn());
    const original = await ice.get();
    await vi.advanceTimersByTimeAsync(HOUR - 300000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(2);
    expect((await ice.get()).expiresAt).toBeGreaterThan(original.expiresAt);
    ice.close();
  });

  it('rechecks absolute expiry when a background tab misses its renewal timer', async () => {
    const fetch = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetch);
    const ice = new MeetingIceConfiguration(vi.fn(), vi.fn());
    const original = await ice.get();
    vi.setSystemTime(original.expiresAt + 1);
    expect((await ice.get()).expiresAt).toBeGreaterThan(original.expiresAt);
    expect(fetch).toHaveBeenCalledTimes(2);
    ice.close();
  });

  it('bounds automatic refresh retries, reports exhaustion, and permits an explicit retry after expiry', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockRejectedValue(new Error('network failure'));
    vi.stubGlobal('fetch', fetch);
    const error = vi.fn();
    const ice = new MeetingIceConfiguration(vi.fn(), error);
    const original = await ice.get();
    await vi.advanceTimersByTimeAsync(HOUR - 300000 + 10000);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toMatchObject({ code: 'ICE_PROVISIONING_FAILED' });
    expect(await ice.get()).toBe(original);
    expect(vi.getTimerCount()).toBe(1);
    vi.setSystemTime(original.expiresAt + 1);
    fetch.mockImplementation(async () => response());
    expect((await ice.get()).expiresAt).toBeGreaterThan(original.expiresAt);
    ice.close();
  });

  it('makes one final renewal attempt at expiry after the refresh retry budget is exhausted', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetch);
    const update = vi.fn();
    const error = vi.fn();
    const ice = new MeetingIceConfiguration(update, error);
    await ice.get();
    await vi.advanceTimersByTimeAsync(HOUR - 300000 + 3000);
    expect(error).toHaveBeenCalledTimes(1);
    fetch.mockImplementation(async () => response());
    await vi.advanceTimersByTimeAsync(300000 - 3000);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(update).toHaveBeenCalledTimes(2);
    ice.close();
  });

  it('recovers a transient refresh failure without displaying an error', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => response());
    vi.stubGlobal('fetch', fetch);
    const error = vi.fn();
    const ice = new MeetingIceConfiguration(vi.fn(), error);
    await ice.get();
    await vi.advanceTimersByTimeAsync(HOUR - 300000 + 1000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(error).not.toHaveBeenCalled();
    ice.close();
  });

  it.each([
    { ok: true, iceServers: [{ urls: 'stun:relay.test:3478' }], expiresAt: 999999999 },
    { ok: true, iceServers: [{ urls: 'turn:relay.test:3478' }], expiresAt: 999999999 },
    { ok: true, iceServers: servers, expiresAt: 0 },
    { ok: true, iceServers: [{ urls: 'https://relay.test', username: 'u', credential: 'p' }], expiresAt: 999999999 },
  ])('rejects unusable credentials without a STUN-only configuration: %j', async (data) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
    const update = vi.fn();
    const ice = new MeetingIceConfiguration(update, vi.fn());
    await expect(ice.get()).rejects.toMatchObject({ code: 'INVALID_ICE_RESPONSE' });
    expect(update).not.toHaveBeenCalled();
    ice.close();
  });

  it('returns a safe configuration error without exposing upstream details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false, code: 'ICE_SERVICE_UNAVAILABLE', message: 'secret upstream diagnostic' }, { status: 503 })));
    const ice = new MeetingIceConfiguration(vi.fn(), vi.fn());
    await expect(ice.get()).rejects.toMatchObject({ code: 'ICE_SERVICE_UNAVAILABLE', message: expect.stringContaining('administrator') });
    ice.close();
  });

  it('aborts an in-flight request on leave and clears its timeout', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal ?? undefined;
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const update = vi.fn();
    const error = vi.fn();
    const ice = new MeetingIceConfiguration(update, error);
    const pending = ice.get();
    const rejected = expect(pending).rejects.toThrow('Meeting closed.');
    ice.close();
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out provisioning and allows the next attempt to succeed', async () => {
    const fetch = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetch);
    const ice = new MeetingIceConfiguration(vi.fn(), vi.fn());
    const pending = expect(ice.get()).rejects.toMatchObject({ code: 'ICE_PROVISIONING_FAILED' });
    await vi.advanceTimersByTimeAsync(10000);
    await pending;
    fetch.mockImplementation(async () => response());
    expect((await ice.get()).iceServers).toEqual(servers);
    ice.close();
  });

  it('clears a synchronously rejected request so another attempt can succeed', async () => {
    const fetch = vi.fn().mockImplementationOnce(() => { throw new TypeError('Request refused'); }).mockImplementation(async () => response());
    vi.stubGlobal('fetch', fetch);
    const ice = new MeetingIceConfiguration(vi.fn(), vi.fn());
    await expect(ice.get()).rejects.toMatchObject({ code: 'ICE_PROVISIONING_FAILED' });
    expect((await ice.get()).iceServers).toEqual(servers);
    expect(fetch).toHaveBeenCalledTimes(2);
    ice.close();
  });
});
