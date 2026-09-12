import { describe, expect, it, vi } from 'vitest';
import type { TranscriptState } from '@weave-in/transcribe';
import { drainCaptionSession } from '../src/caption-session';

describe('public caption drain', () => {
  it('keeps the subscription until capture stops and delivers its final snapshot before private capture starts', async () => {
    let stopped!: () => void;
    const stopping = new Promise<void>(resolve => { stopped = resolve; });
    const calls: string[] = [];
    const final = { segments: [{ id: 1, text: 'Weave, go ahead.' }], interim: '' } as unknown as TranscriptState;
    const transcription = {
      stop: vi.fn(async () => { calls.push('stop'); await stopping; return {} as never; }),
      getState: () => final,
      destroy: vi.fn(async () => { calls.push('destroy'); }),
    };
    const publish = vi.fn((state: TranscriptState) => { expect(state).toBe(final); calls.push('final'); });
    const done = drainCaptionSession(transcription, () => calls.push('unsubscribe'), publish);
    expect(calls).toEqual(['stop']);
    expect(publish).not.toHaveBeenCalled();
    stopped(); await done;
    calls.push('private capture');
    expect(calls).toEqual(['stop', 'final', 'unsubscribe', 'destroy', 'private capture']);
  });
});
