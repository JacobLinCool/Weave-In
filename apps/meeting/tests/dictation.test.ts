import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Dictation } from '../src/agents/dictation';

const mock = vi.hoisted(() => ({ create: vi.fn(), token: vi.fn(), meter: vi.fn(() => vi.fn()) }));
vi.mock('@weave-in/transcribe', () => ({ createTranscription: mock.create }));
vi.mock('../src/transcription-token', () => ({ requestTranscriptionToken: mock.token }));
vi.mock('../src/voice-activity', () => ({ observeVoiceActivity: mock.meter }));
let dictation: Dictation;
beforeEach(() => { mock.token.mockResolvedValue({ provider: 'openai', token: 'test' }); });
afterEach(async () => { await dictation?.cancel(); vi.clearAllMocks(); });
function setup() {
  const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
  const media = { beginVoice: vi.fn(async (_audience: 'private', _owner: string) => track), endVoice: vi.fn() };
  const state = { segments: [] as { text: string }[], interim: '', error: null };
  let publish = (_state: typeof state) => {};
  const session = { addAudioSource: vi.fn(), subscribe: vi.fn(fn => { publish = fn; fn(state); return vi.fn(); }), start: vi.fn(async () => ({ ok: true })), stop: vi.fn(async () => ({ ok: true })), getState: () => state, destroy: vi.fn(async () => {}) };
  mock.create.mockReturnValue(session);
  dictation = new Dictation(media);
  return { media, state, session, track, publish: () => publish(state) };
}
it('keeps interim text private and waits for the final words before returning a draft', async () => {
  const { media, state, session, track, publish } = setup();
  await dictation.start();
  state.interim = 'Review the'; publish();
  expect(dictation.snapshot()).toMatchObject({ status: 'recording', text: 'Review the' });
  let finish!: () => void;
  session.stop.mockImplementationOnce(() => new Promise(resolve => { finish = () => { state.segments = [{ text: 'Review the plan.' }]; state.interim = ''; publish(); resolve({ ok: true }); }; }));
  let completed = false;
  const stopping = dictation.stop().then(text => { completed = true; return text; });
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(dictation.snapshot().status).toBe('stopping');
  finish();
  expect(await stopping).toBe('Review the plan.');
  expect(session.destroy).toHaveBeenCalledOnce();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(media.beginVoice).toHaveBeenCalledWith('private', expect.any(String));
  expect(media.endVoice).toHaveBeenCalledWith(media.beginVoice.mock.calls[0]![1]);
});
it('restores the meeting microphone when token issuance fails', async () => {
  const { media, track } = setup(); mock.token.mockRejectedValueOnce(new Error('Token unavailable'));
  await expect(dictation.start()).rejects.toThrow('Token unavailable');
  expect(track.stop).toHaveBeenCalledOnce(); expect(media.endVoice).toHaveBeenCalled();
  expect(dictation.snapshot()).toMatchObject({ status: 'idle', error: 'Token unavailable' });
});
it('cancels a pending microphone capture without creating a transcription session', async () => {
  const { media, track } = setup(); let finish!: (track: MediaStreamTrack) => void;
  media.beginVoice.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const starting = dictation.start(); const rejected = expect(starting).rejects.toThrow();
  const cancelled = dictation.cancel(); finish(track); await rejected; await cancelled;
  expect(mock.create).not.toHaveBeenCalled(); expect(track.stop).toHaveBeenCalledOnce();
  expect(dictation.snapshot().status).toBe('idle');
});
