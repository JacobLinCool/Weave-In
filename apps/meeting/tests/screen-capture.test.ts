import { afterEach, expect, it, vi } from 'vitest';
import { captureVideoFrame } from '../src/screen-capture';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('times out and releases a receiver even when video.play never resolves', async () => {
  vi.useFakeTimers();
  const video = { muted: false, playsInline: false, srcObject: null as unknown, play: () => new Promise<void>(() => undefined), pause: vi.fn(), requestVideoFrameCallback: vi.fn(), addEventListener: vi.fn() };
  vi.stubGlobal('document', { createElement: () => video });
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const stream = { getVideoTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream;
  const result = captureVideoFrame(stream, { maxWidth: 1280, format: 'jpeg', quality: 0.8 });
  const rejected = expect(result).rejects.toThrow('No frame arrived');
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(video.pause).toHaveBeenCalledOnce();
  expect(video.srcObject).toBeNull();
});
