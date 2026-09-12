import type { Transcription, TranscriptState } from '@weave-in/transcribe';

/** Drain only the old public capture before detaching it or enabling private capture. */
export async function drainCaptionSession(
  transcription: Pick<Transcription, 'stop' | 'getState' | 'destroy'>,
  unsubscribe: (() => void) | null,
  publishFinal: (state: TranscriptState) => void,
): Promise<void> {
  try {
    await transcription.stop();
    publishFinal(transcription.getState());
  } finally {
    unsubscribe?.();
    await transcription.destroy();
  }
}
