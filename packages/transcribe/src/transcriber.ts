import type { PcmAudioFormat } from './audio-mixer';
import type {
  CredentialInput,
  TranscriptionOptions,
  TranscriptionProvider,
} from './contracts';
import { GeminiLiveTranscriber } from './gemini-live';
import { OpenAiLiveTranscriber } from './openai-live';
import { TranscribeError } from './errors';

export interface LiveTranscriptionCallbacks {
  onInterim(text: string): void;
  onFinal(text: string, connection: number): void;
  onConnectionReady(connection: number): void;
  onFatalError(code: string, message: string): void;
}

export interface LiveTranscriber {
  readonly audioFormat: PcmAudioFormat;
  start(): Promise<void>;
  sendAudio(chunk: ArrayBuffer): void;
  stop(): Promise<void>;
}

export interface LiveTranscriberArguments {
  provider: TranscriptionProvider;
  credential: CredentialInput | null;
  options: TranscriptionOptions;
  callbacks: LiveTranscriptionCallbacks;
}

export function createLiveTranscriber(args: LiveTranscriberArguments): LiveTranscriber {
  switch (args.provider) {
    case 'gemini':
      if (!args.credential) {
        throw new TranscribeError('MISSING_CREDENTIAL', 'Gemini transcription requires a credential.');
      }
      return new GeminiLiveTranscriber({
        credential: args.credential,
        options: args.options,
        callbacks: args.callbacks,
      });
    case 'openai':
      if (!args.credential) {
        throw new TranscribeError('MISSING_CREDENTIAL', 'OpenAI transcription requires a credential.');
      }
      return new OpenAiLiveTranscriber({
        credential: args.credential,
        options: args.options,
        callbacks: args.callbacks,
      });
  }
}
