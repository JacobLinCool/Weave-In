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
const RETRY_INITIAL_MS = 2_000;
const RETRY_MAX_MS = 30_000;

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
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #retryAttempt = 0;
  #reconnecting = false;
  #rotating = false;
  #cancelSetup: (() => void) | null = null;

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
    if (this.#socket || this.#stopping || this.#reconnecting || this.#retryTimer !== null) {
      throw new TranscribeError('SESSION_ACTIVE', 'The Gemini Live client has already started.');
    }
    await this.#connect('initial');
  }

  sendAudio(pcm16: ArrayBuffer): void {
    if (this.#stopping || pcm16.byteLength === 0) return;
    if (this.#ready && this.#socket?.readyState === WebSocket.OPEN) {
      try {
        this.#sendAudioNow(this.#socket, pcm16);
        return;
      } catch {
        this.#scheduleReconnect();
      }
    }
    // Keep recent unsent audio without terminating the meeting on a long outage.
    if (this.#queuedAudio.length >= MAX_QUEUED_CHUNKS) this.#queuedAudio.shift();
    this.#queuedAudio.push(pcm16);
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#ready = false;
    this.#clearRotationTimer();
    this.#clearRetryTimer();
    this.#cancelSetup?.();
    const socket = this.#socket;
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
        await delay(STOP_FINALIZATION_MS, this.#dependencies);
      } catch { /* A concurrent transport failure must not prevent stopping. */ }
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
    if (this.#stopping) throw new TranscribeError('ABORTED', 'Transcription stopped.');
    const url = endpointForCredential(credential);
    const socket = this.#dependencies.createWebSocket(url);
    this.#socket = socket;
    this.#ready = false;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const failSetup = (message: string, code = 'GEMINI_SETUP_FAILED'): void => {
        if (settled) return;
        settled = true;
        this.#dependencies.clearTimeout(setupTimer);
        this.#cancelSetup = null;
        if (socket === this.#socket) {
          this.#socket = null;
          this.#ready = false;
        }
        if (socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Setup failed');
        reject(new TranscribeError(code, this.#redact(message)));
      };
      const setupTimer = this.#dependencies.setTimeout(() => {
        failSetup('Gemini Live did not finish setup within 15 seconds.', 'GEMINI_SETUP_TIMEOUT');
      }, SETUP_TIMEOUT_MS);
      this.#cancelSetup = () => failSetup('Transcription stopped.', 'ABORTED');

      const finishSetup = (): void => {
        if (settled || this.#stopping || socket !== this.#socket) return;
        settled = true;
        this.#dependencies.clearTimeout(setupTimer);
        this.#cancelSetup = null;
        this.#ready = true;
        this.#connectionCount += 1;
        this.#retryAttempt = 0;
        this.#callbacks.onConnectionReady(this.#connectionCount);
        this.#scheduleRotation();
        resolve();
        this.#flushQueuedAudio();
      };

      socket.addEventListener('open', () => {
        if (socket !== this.#socket || this.#stopping) return;
        try { socket.send(JSON.stringify(this.#createSetupMessage())); }
        catch { failSetup('Gemini Live WebSocket setup send failed.'); }
      });
      socket.addEventListener('message', (event) => {
        void this.#handleMessage(event.data, socket, finishSetup, failSetup);
      });
      socket.addEventListener('error', () => {
        if (socket !== this.#socket || this.#stopping) return;
        if (!settled) failSetup('Gemini Live WebSocket connection failed.');
        else this.#scheduleReconnect();
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
          this.#scheduleReconnect();
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
      if (!raw || socket !== this.#socket) return;
      const message = JSON.parse(raw) as GeminiServerMessage;
      if (message.error) {
        const apiMessage = message.error.message || 'Gemini Live returned an unknown error.';
        if (!this.#ready) failSetup(apiMessage);
        else if (message.error.code === 429 || (message.error.code ?? 0) >= 500) this.#scheduleReconnect();
        else this.#reportFatal('GEMINI_API_ERROR', apiMessage);
        return;
      }
      if (message.setupComplete !== undefined) finishSetup();
      if (message.goAway && this.#ready) void this.#rotateConnection();
      const interim = message.serverContent?.interimInputTranscription?.text;
      const final = message.serverContent?.inputTranscription?.text;
      if (typeof interim === 'string') this.#callbacks.onInterim(interim);
      if (typeof final === 'string') this.#callbacks.onFinal(final, this.#connectionCount);
    } catch {
      if (socket !== this.#socket) return;
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
    for (const chunk of queued) this.sendAudio(chunk);
  }

  #scheduleRotation(): void {
    this.#clearRotationTimer();
    this.#rotationTimer = this.#dependencies.setTimeout(() => {
      void this.#rotateConnection();
    }, GEMINI_ROTATION_INTERVAL_MS);
  }

  async #rotateConnection(): Promise<void> {
    if (this.#stopping || this.#rotating || this.#reconnecting || this.#retryTimer !== null) return;
    this.#rotating = true;
    this.#ready = false;
    this.#clearRotationTimer();
    const oldSocket = this.#socket;
    try {
      if (oldSocket?.readyState === WebSocket.OPEN) {
        oldSocket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
        await delay(ROTATION_FINALIZATION_MS, this.#dependencies);
      }
    } catch { /* Reconnect even if the old socket can no longer send. */ }
    this.#rotating = false;
    if (this.#stopping) return;
    this.#detachSocket();
    await this.#reconnect();
  }

  #detachSocket(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#ready = false;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Reconnecting');
  }

  #scheduleReconnect(): void {
    if (this.#stopping || this.#fatalErrorReported || this.#rotating) return;
    this.#clearRotationTimer();
    this.#detachSocket();
    if (this.#retryTimer !== null) return;
    this.#callbacks.onInterim('');
    this.#callbacks.onReconnecting?.();
    const waitMs = Math.min(RETRY_INITIAL_MS * 2 ** Math.min(this.#retryAttempt++, 4), RETRY_MAX_MS);
    this.#retryTimer = this.#dependencies.setTimeout(() => {
      this.#retryTimer = null;
      void this.#reconnect();
    }, waitMs);
  }

  async #reconnect(): Promise<void> {
    if (this.#stopping || this.#reconnecting) return;
    this.#reconnecting = true;
    try {
      // Ephemeral credentials are single-use: ask the provider on every attempt.
      await this.#connect('rotation');
    } catch {
      this.#scheduleReconnect();
    } finally {
      this.#reconnecting = false;
    }
  }

  #clearRetryTimer(): void {
    if (this.#retryTimer === null) return;
    this.#dependencies.clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #reportFatal(code: string, message: string): void {
    if (this.#fatalErrorReported || this.#stopping) return;
    this.#fatalErrorReported = true;
    this.#clearRotationTimer();
    this.#clearRetryTimer();
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
  goAway?: { timeLeft?: string };
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

function delay(milliseconds: number, dependencies: GeminiLiveDependencies): Promise<void> {
  return new Promise((resolve) => dependencies.setTimeout(resolve, milliseconds));
}
