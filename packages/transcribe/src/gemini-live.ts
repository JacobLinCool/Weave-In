import {
  cloneOptions,
  GEMINI_MODEL,
  type Credential,
  type CredentialInput,
  type TranscriptionOptions,
} from './contracts';
import { arrayBufferToBase64 } from './audio-encoding';
import { TranscribeError } from './errors';
import type { LiveTranscriber, LiveTranscriptionCallbacks } from './transcriber';

const API_KEY_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const EPHEMERAL_TOKEN_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const SETUP_TIMEOUT_MS = 15_000;
export const GEMINI_ROTATION_INTERVAL_MS = 9 * 60 * 1_000;
const ROTATION_FINALIZATION_MS = 750;
const STOP_FINALIZATION_MS = 900;
const MAX_QUEUED_CHUNKS = 100;

export interface GeminiLiveDependencies {
  createWebSocket(url: string): WebSocket;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const DEFAULT_DEPENDENCIES: GeminiLiveDependencies = {
  createWebSocket: (url) => new WebSocket(url),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
};

export class GeminiLiveTranscriber implements LiveTranscriber {
  readonly audioFormat = Object.freeze({ sampleRate: 16_000, framesPerChunk: 1_600 });
  readonly #credential: CredentialInput;
  readonly #options: TranscriptionOptions;
  readonly #callbacks: LiveTranscriptionCallbacks;
  readonly #dependencies: GeminiLiveDependencies;
  readonly #secrets = new Set<string>();
  #socket: WebSocket | null = null;
  #ready = false;
  #stopping = false;
  #connectionCount = 0;
  #queuedAudio: ArrayBuffer[] = [];
  #rotationTimer: ReturnType<typeof setTimeout> | null = null;
  #fatalErrorReported = false;

  constructor(args: {
    credential: CredentialInput;
    options: TranscriptionOptions;
    callbacks: LiveTranscriptionCallbacks;
    dependencies?: GeminiLiveDependencies;
  }) {
    this.#credential = args.credential;
    this.#options = cloneOptions(args.options);
    this.#callbacks = args.callbacks;
    this.#dependencies = args.dependencies ?? DEFAULT_DEPENDENCIES;
  }

  get connectionCount(): number {
    return this.#connectionCount;
  }

  async start(): Promise<void> {
    if (this.#socket || this.#stopping) {
      throw new TranscribeError('SESSION_ACTIVE', 'The Gemini Live client has already started.');
    }
    await this.#connect('initial');
  }

  sendAudio(pcm16: ArrayBuffer): void {
    if (this.#stopping || pcm16.byteLength === 0) return;
    if (this.#ready && this.#socket?.readyState === WebSocket.OPEN) {
      this.#sendAudioNow(this.#socket, pcm16);
      return;
    }
    if (this.#queuedAudio.length >= MAX_QUEUED_CHUNKS) {
      this.#reportFatal(
        'AUDIO_BUFFER_OVERFLOW',
        'The live connection could not accept audio for 10 seconds.',
      );
      return;
    }
    this.#queuedAudio.push(pcm16);
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#ready = false;
    this.#clearRotationTimer();
    const socket = this.#socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      await delay(STOP_FINALIZATION_MS, this.#dependencies);
    }
    this.#socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, 'Transcription stopped');
    }
    this.#queuedAudio = [];
    this.#secrets.clear();
  }

  async #connect(reason: 'initial' | 'rotation'): Promise<void> {
    const credential = await this.#resolveCredential(reason);
    const url = endpointForCredential(credential);
    const socket = this.#dependencies.createWebSocket(url);
    this.#socket = socket;
    this.#ready = false;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const setupTimer = this.#dependencies.setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#socket = null;
        socket.close(1000, 'Setup timeout');
        reject(
          new TranscribeError(
            'GEMINI_SETUP_TIMEOUT',
            'Gemini Live did not finish setup within 15 seconds.',
          ),
        );
      }, SETUP_TIMEOUT_MS);

      const finishSetup = (): void => {
        if (settled) return;
        settled = true;
        this.#dependencies.clearTimeout(setupTimer);
        this.#ready = true;
        this.#connectionCount += 1;
        this.#flushQueuedAudio();
        this.#callbacks.onConnectionReady(this.#connectionCount);
        this.#scheduleRotation();
        resolve();
      };

      const failSetup = (message: string): void => {
        if (settled) return;
        settled = true;
        this.#dependencies.clearTimeout(setupTimer);
        this.#socket = null;
        reject(new TranscribeError('GEMINI_SETUP_FAILED', this.#redact(message)));
      };

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify(this.#createSetupMessage()));
      });
      socket.addEventListener('message', (event) => {
        void this.#handleMessage(event.data, socket, finishSetup, failSetup);
      });
      socket.addEventListener('error', () => {
        if (!this.#ready) failSetup('Gemini Live WebSocket connection failed.');
      });
      socket.addEventListener('close', (event) => {
        if (socket !== this.#socket) return;
        this.#socket = null;
        this.#ready = false;
        if (!settled) {
          failSetup(closeMessage(event));
          return;
        }
        if (!this.#stopping) {
          this.#reportFatal('GEMINI_CONNECTION_CLOSED', closeMessage(event));
        }
      });
    });
  }

  async #resolveCredential(reason: 'initial' | 'rotation'): Promise<Credential> {
    let credential: Credential;
    try {
      credential =
        typeof this.#credential === 'function'
          ? await this.#credential({
              reason,
              connection: this.#connectionCount + 1,
              provider: 'gemini',
            })
          : this.#credential;
    } catch {
      throw new TranscribeError(
        'CREDENTIAL_PROVIDER_FAILED',
        'The credential provider could not supply a Gemini credential.',
      );
    }

    if (
      !credential ||
      (credential.type !== 'api-key' && credential.type !== 'ephemeral-token') ||
      typeof credential.value !== 'string' ||
      credential.value.trim().length === 0
    ) {
      throw new TranscribeError(
        'INVALID_CREDENTIAL',
        'Provide a non-empty Gemini API key or ephemeral token.',
      );
    }
    const normalized = { ...credential, value: credential.value.trim() };
    this.#secrets.add(normalized.value);
    return normalized;
  }

  #createSetupMessage(): object {
    const transcriptionConfig: Record<string, unknown> = {
      languageCodes: [...this.#options.languageCodes],
      mode: this.#options.mode,
    };
    if (this.#options.customVocabulary.length > 0) {
      transcriptionConfig.customVocabulary = this.#options.customVocabulary;
    }
    return {
      setup: {
        model: `models/${GEMINI_MODEL}`,
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: transcriptionConfig,
      },
    };
  }

  async #handleMessage(
    data: unknown,
    socket: WebSocket,
    finishSetup: () => void,
    failSetup: (message: string) => void,
  ): Promise<void> {
    if (socket !== this.#socket) return;
    try {
      const raw =
        typeof data === 'string' ? data : data instanceof Blob ? await data.text() : '';
      if (!raw) return;
      const message = JSON.parse(raw) as GeminiServerMessage;
      if (message.error) {
        const apiMessage = message.error.message || 'Gemini Live returned an unknown error.';
        if (!this.#ready) failSetup(apiMessage);
        else this.#reportFatal('GEMINI_API_ERROR', apiMessage);
        return;
      }
      if (message.setupComplete !== undefined) finishSetup();
      const interim = message.serverContent?.interimInputTranscription?.text;
      const final = message.serverContent?.inputTranscription?.text;
      if (typeof interim === 'string') this.#callbacks.onInterim(interim);
      if (typeof final === 'string') this.#callbacks.onFinal(final, this.#connectionCount);
    } catch {
      this.#reportFatal('INVALID_GEMINI_RESPONSE', 'Gemini Live returned an invalid response.');
    }
  }

  #sendAudioNow(socket: WebSocket, pcm16: ArrayBuffer): void {
    socket.send(
      JSON.stringify({
        realtimeInput: {
          audio: { data: arrayBufferToBase64(pcm16), mimeType: 'audio/pcm;rate=16000' },
        },
      }),
    );
  }

  #flushQueuedAudio(): void {
    const socket = this.#socket;
    if (!this.#ready || socket?.readyState !== WebSocket.OPEN) return;
    const queued = this.#queuedAudio;
    this.#queuedAudio = [];
    for (const chunk of queued) this.#sendAudioNow(socket, chunk);
  }

  #scheduleRotation(): void {
    this.#clearRotationTimer();
    this.#rotationTimer = this.#dependencies.setTimeout(() => {
      void this.#rotateConnection();
    }, GEMINI_ROTATION_INTERVAL_MS);
  }

  async #rotateConnection(): Promise<void> {
    if (this.#stopping) return;
    this.#ready = false;
    const oldSocket = this.#socket;
    if (oldSocket?.readyState === WebSocket.OPEN) {
      oldSocket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      await delay(ROTATION_FINALIZATION_MS, this.#dependencies);
    }
    this.#socket = null;
    if (oldSocket && oldSocket.readyState < WebSocket.CLOSING) {
      oldSocket.close(1000, 'Scheduled session rotation');
    }
    try {
      await this.#connect('rotation');
    } catch (error) {
      this.#reportFatal('GEMINI_ROTATION_FAILED', safeMessage(error));
    }
  }

  #reportFatal(code: string, message: string): void {
    if (this.#fatalErrorReported || this.#stopping) return;
    this.#fatalErrorReported = true;
    this.#clearRotationTimer();
    this.#callbacks.onFatalError(code, this.#redact(message));
  }

  #clearRotationTimer(): void {
    if (this.#rotationTimer === null) return;
    this.#dependencies.clearTimeout(this.#rotationTimer);
    this.#rotationTimer = null;
  }

  #redact(message: string): string {
    let redacted = message.replace(/([?&](?:key|access_token)=)[^&\s]+/giu, '$1[redacted]');
    for (const secret of this.#secrets) redacted = redacted.replaceAll(secret, '[redacted]');
    return redacted;
  }
}

interface GeminiServerMessage {
  setupComplete?: object;
  serverContent?: {
    interimInputTranscription?: { text?: string };
    inputTranscription?: { text?: string };
  };
  error?: { code?: number; message?: string; status?: string };
}

function endpointForCredential(credential: Credential): string {
  return credential.type === 'api-key'
    ? `${API_KEY_ENDPOINT}?key=${encodeURIComponent(credential.value)}`
    : `${EPHEMERAL_TOKEN_ENDPOINT}?access_token=${encodeURIComponent(credential.value)}`;
}

function closeMessage(event: CloseEvent): string {
  const reason = event.reason.trim();
  return reason
    ? `Gemini Live closed the connection (${event.code}): ${reason}`
    : `Gemini Live closed the connection (${event.code}).`;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unknown Gemini Live error occurred.';
}

function delay(milliseconds: number, dependencies: GeminiLiveDependencies): Promise<void> {
  return new Promise((resolve) => dependencies.setTimeout(resolve, milliseconds));
}
