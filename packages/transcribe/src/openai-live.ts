import { arrayBufferToBase64 } from './audio-encoding';
import {
  cloneOptions,
  OPENAI_MODEL,
  type Credential,
  type CredentialInput,
  type TranscriptionOptions,
} from './contracts';
import { TranscribeError } from './errors';
import type { LiveTranscriber, LiveTranscriptionCallbacks } from './transcriber';

const REALTIME_ENDPOINT = 'wss://api.openai.com/v1/realtime?intent=transcription';
const SETUP_TIMEOUT_MS = 15_000;
export const OPENAI_ROTATION_INTERVAL_MS = 9 * 60 * 1_000;
const ROTATION_FINALIZATION_MS = 750;
const STOP_FINALIZATION_MS = 900;
const MAX_QUEUED_CHUNKS = 100;
// ponytail: RMS endpointing assumes ordinary microphone levels; use a VAD model if noisy-room evals require it.
const SPEECH_RMS = 0.005;
const END_OF_SPEECH_MS = 800;

export interface OpenAiLiveDependencies {
  createWebSocket(url: string, protocols: string[]): WebSocket;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const DEFAULT_DEPENDENCIES: OpenAiLiveDependencies = {
  createWebSocket: (url, protocols) => new WebSocket(url, protocols),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
};

interface TranscriptItem {
  text: string;
  finalText: string | null;
}

export class OpenAiLiveTranscriber implements LiveTranscriber {
  readonly audioFormat = Object.freeze({ sampleRate: 24_000, framesPerChunk: 2_400 });
  readonly #credential: CredentialInput;
  readonly #options: TranscriptionOptions;
  readonly #callbacks: LiveTranscriptionCallbacks;
  readonly #dependencies: OpenAiLiveDependencies;
  readonly #secrets = new Set<string>();
  readonly #items = new Map<string, TranscriptItem>();
  readonly #itemOrder: string[] = [];
  #socket: WebSocket | null = null;
  #ready = false;
  #stopping = false;
  #connectionCount = 0;
  #queuedAudio: ArrayBuffer[] = [];
  #rotationTimer: ReturnType<typeof setTimeout> | null = null;
  #fatalErrorReported = false;
  #sentAudioSinceCommit = false;
  #bufferedAudioMs = 0;
  #silentAudioMs = 0;
  #pendingCommits = 0;
  readonly #finalizationWaiters = new Set<() => void>();

  constructor(args: {
    credential: CredentialInput;
    options: TranscriptionOptions;
    callbacks: LiveTranscriptionCallbacks;
    dependencies?: OpenAiLiveDependencies;
  }) {
    this.#credential = args.credential;
    this.#options = cloneOptions(args.options);
    this.#callbacks = args.callbacks;
    this.#dependencies = args.dependencies ?? DEFAULT_DEPENDENCIES;
  }

  async start(): Promise<void> {
    if (this.#socket || this.#stopping) {
      throw new TranscribeError('SESSION_ACTIVE', 'The OpenAI Realtime client has already started.');
    }
    validateOpenAiOptions(this.#options);
    await this.#connect('initial');
  }

  sendAudio(pcm16: ArrayBuffer): void {
    if (this.#stopping || pcm16.byteLength === 0) return;
    if (this.#ready && this.#socket?.readyState === 1) {
      this.#sendAudioNow(this.#socket, pcm16);
      return;
    }
    if (this.#queuedAudio.length >= MAX_QUEUED_CHUNKS) {
      this.#reportFatal(
        'AUDIO_BUFFER_OVERFLOW',
        'The OpenAI live connection could not accept audio for 10 seconds.',
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
    await this.#finalizeCurrentBuffer(STOP_FINALIZATION_MS);
    this.#closeConnection();
    this.#queuedAudio = [];
    this.#items.clear();
    this.#itemOrder.length = 0;
    this.#secrets.clear();
  }

  async #connect(reason: 'initial' | 'rotation'): Promise<void> {
    const credential = await this.#resolveCredential(reason);
    if (this.#stopping) return;
    let socket: WebSocket;
    try {
      socket = this.#dependencies.createWebSocket(REALTIME_ENDPOINT, [
        'realtime', `openai-insecure-api-key.${credential.value}`,
      ]);
    } catch (error) {
      throw new TranscribeError('OPENAI_SETUP_FAILED', this.#redact(safeMessage(error, 'OpenAI Realtime connection failed.')));
    }
    this.#socket = socket;
    this.#ready = false;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const setupTimer = this.#dependencies.setTimeout(() => {
        failSetup(
          new TranscribeError(
            'OPENAI_SETUP_TIMEOUT',
            'OpenAI Realtime did not finish setup within 15 seconds.',
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

      const failSetup = (error: TranscribeError): void => {
        if (settled) return;
        settled = true;
        this.#dependencies.clearTimeout(setupTimer);
        this.#closeConnection();
        reject(error);
      };

      socket.addEventListener('open', () => {
        if (socket !== this.#socket) return;
        socket.send(JSON.stringify(this.#createSessionUpdate()));
      });
      socket.addEventListener('message', (event) => {
        this.#handleMessage(event.data, socket, finishSetup, failSetup);
      });
      socket.addEventListener('error', () => {
        if (socket !== this.#socket) return;
        const error = new TranscribeError(
          'OPENAI_CONNECTION_FAILED', 'OpenAI Realtime WebSocket failed.',
        );
        if (!this.#ready) failSetup(error);
        else this.#reportFatal(error.code, error.message);
      });
      socket.addEventListener('close', () => {
        if (socket !== this.#socket || this.#stopping) return;
        const error = new TranscribeError(
          'OPENAI_CONNECTION_CLOSED', 'OpenAI Realtime closed the transcription connection.',
        );
        if (!settled) failSetup(error);
        else this.#reportFatal(error.code, error.message);
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
              provider: 'openai',
            })
          : this.#credential;
    } catch {
      throw new TranscribeError(
        'CREDENTIAL_PROVIDER_FAILED',
        'The credential provider could not supply an OpenAI credential.',
      );
    }
    if (!credential || typeof credential.value !== 'string' || credential.value.trim().length === 0) {
      throw new TranscribeError(
        'INVALID_CREDENTIAL',
        'Provide a non-empty OpenAI API key or ephemeral token.',
      );
    }
    if (credential.type !== 'api-key' && credential.type !== 'ephemeral-token') {
      throw new TranscribeError(
        'INVALID_CREDENTIAL',
        'Provide a non-empty OpenAI API key or ephemeral token.',
      );
    }
    const normalized = { ...credential, value: credential.value.trim() };
    this.#secrets.add(normalized.value);
    return normalized;
  }

  #createSessionUpdate(): object {
    const transcription: Record<string, unknown> = {
      model: OPENAI_MODEL,
      prompt:
        this.#options.mode === 'VERBATIM'
          ? 'Transcribe verbatim. Preserve filler words, repetitions, and false starts.'
          : 'Produce a readable transcript with punctuation while preserving the speaker’s meaning.',
      delay: 'low',
    };
    const languages = [...new Set(this.#options.languageCodes.map(openAiLanguageHint).filter(Boolean))];
    if (languages.length > 0) transcription.languages = languages;
    if (this.#options.customVocabulary.length > 0) {
      transcription.keywords = this.#options.customVocabulary;
    }
    return {
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24_000 },
            transcription,
            turn_detection: null,
          },
        },
      },
    };
  }

  #handleMessage(
    data: unknown,
    channel: WebSocket,
    finishSetup: () => void,
    failSetup: (error: TranscribeError) => void,
  ): void {
    if (channel !== this.#socket || typeof data !== 'string') return;
    try {
      const event = JSON.parse(data) as OpenAiServerEvent;
      if (event.type === 'error') {
        const message = this.#redact(event.error?.message || 'OpenAI Realtime returned an unknown error.');
        const error = new TranscribeError('OPENAI_API_ERROR', message);
        if (!this.#ready) failSetup(error);
        else this.#reportFatal(error.code, error.message);
        return;
      }
      if (event.type === 'session.updated') {
        finishSetup();
        return;
      }
      if (event.type === 'conversation.item.created' && event.item?.id) {
        this.#ensureItem(event.item.id);
        return;
      }
      if (event.type === 'input_audio_buffer.committed') {
        if (event.item_id) this.#ensureItem(event.item_id);
        return;
      }
      if (
        event.type === 'conversation.item.input_audio_transcription.delta' &&
        event.item_id &&
        typeof event.delta === 'string'
      ) {
        const item = this.#ensureItem(event.item_id);
        item.text += event.delta;
        this.#emitInterim();
        return;
      }
      if (
        event.type === 'conversation.item.input_audio_transcription.completed' &&
        event.item_id &&
        typeof event.transcript === 'string'
      ) {
        const item = this.#ensureItem(event.item_id);
        item.finalText = event.transcript;
        this.#flushCompletedItems();
        this.#pendingCommits = Math.max(0, this.#pendingCommits - 1);
        if (this.#pendingCommits === 0) {
          for (const finish of this.#finalizationWaiters) finish();
        }
      }
    } catch {
      const error = new TranscribeError(
        'INVALID_OPENAI_RESPONSE',
        'OpenAI Realtime returned an invalid response.',
      );
      if (!this.#ready) failSetup(error);
      else this.#reportFatal(error.code, error.message);
    }
  }

  #ensureItem(itemId: string): TranscriptItem {
    const existing = this.#items.get(itemId);
    if (existing) return existing;
    const item: TranscriptItem = { text: '', finalText: null };
    this.#items.set(itemId, item);
    this.#itemOrder.push(itemId);
    return item;
  }

  #flushCompletedItems(): void {
    while (this.#itemOrder.length > 0) {
      const itemId = this.#itemOrder[0];
      if (!itemId) break;
      const item = this.#items.get(itemId);
      if (!item || item.finalText === null) break;
      this.#itemOrder.shift();
      this.#items.delete(itemId);
      if (item.finalText.trim()) this.#callbacks.onFinal(item.finalText, this.#connectionCount);
    }
    this.#emitInterim();
  }

  #emitInterim(): void {
    const interim = this.#itemOrder
      .map((itemId) => this.#items.get(itemId))
      .filter((item): item is TranscriptItem => Boolean(item) && item?.finalText === null)
      .map((item) => item.text)
      .filter(Boolean)
      .join('\n');
    this.#callbacks.onInterim(interim);
  }

  #sendAudioNow(channel: WebSocket, pcm16: ArrayBuffer): void {
    const samples = new Int16Array(pcm16);
    const rms = Math.sqrt(samples.reduce((sum, sample) => sum + (sample / 32768) ** 2, 0) / samples.length);
    const speaking = rms >= SPEECH_RMS;
    // Do not commit empty turns or accumulate minutes of silence before speech.
    if (!speaking && !this.#sentAudioSinceCommit) return;
    channel.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: arrayBufferToBase64(pcm16) }));
    this.#sentAudioSinceCommit = true;
    const duration = samples.length / this.audioFormat.sampleRate * 1000;
    this.#bufferedAudioMs += duration;
    this.#silentAudioMs = speaking ? 0 : this.#silentAudioMs + duration;
    if (this.#silentAudioMs >= END_OF_SPEECH_MS) this.#commitAudio(channel);
  }

  #commitAudio(channel: WebSocket): boolean {
    // The API requires at least 100 ms in a committed buffer.
    if (!this.#sentAudioSinceCommit || this.#bufferedAudioMs < 100) return false;
    this.#pendingCommits += 1;
    channel.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    this.#sentAudioSinceCommit = false;
    this.#bufferedAudioMs = 0;
    this.#silentAudioMs = 0;
    return true;
  }

  #flushQueuedAudio(): void {
    const channel = this.#socket;
    if (!this.#ready || channel?.readyState !== 1) return;
    const queued = this.#queuedAudio;
    this.#queuedAudio = [];
    for (const chunk of queued) this.#sendAudioNow(channel, chunk);
  }

  #scheduleRotation(): void {
    this.#clearRotationTimer();
    this.#rotationTimer = this.#dependencies.setTimeout(() => {
      void this.#rotateConnection();
    }, OPENAI_ROTATION_INTERVAL_MS);
  }

  async #rotateConnection(): Promise<void> {
    if (this.#stopping) return;
    this.#ready = false;
    await this.#finalizeCurrentBuffer(ROTATION_FINALIZATION_MS);
    this.#closeConnection();
    try {
      await this.#connect('rotation');
    } catch (error) {
      this.#reportFatal(
        'OPENAI_ROTATION_FAILED',
        this.#redact(safeMessage(error, 'OpenAI Realtime rotation failed.')),
      );
    }
  }

  async #finalizeCurrentBuffer(delayMs: number): Promise<void> {
    const channel = this.#socket;
    if (channel?.readyState !== 1) return;
    this.#commitAudio(channel);
    if (this.#pendingCommits === 0) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        this.#dependencies.clearTimeout(timer);
        this.#finalizationWaiters.delete(finish);
        resolve();
      };
      const timer = this.#dependencies.setTimeout(finish, delayMs);
      this.#finalizationWaiters.add(finish);
    });
  }

  #closeConnection(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#ready = false;
    this.#sentAudioSinceCommit = false;
    this.#bufferedAudioMs = 0;
    this.#silentAudioMs = 0;
    this.#pendingCommits = 0;
    // A timed-out final belongs to this connection; it cannot block later connections.
    this.#items.clear();
    this.#itemOrder.length = 0;
    this.#emitInterim();
    for (const finish of this.#finalizationWaiters) finish();
    if (socket && socket.readyState < 2) socket.close(1000, 'Transcription stopped');
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
    let redacted = message.replace(/(Bearer\s+)[A-Za-z0-9._-]+/giu, '$1[redacted]');
    for (const secret of this.#secrets) redacted = redacted.replaceAll(secret, '[redacted]');
    return redacted;
  }
}

interface OpenAiServerEvent {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  item?: { id?: string };
  error?: { message?: string };
}

function validateOpenAiOptions(options: TranscriptionOptions): void {
  const invalidKeyword = options.customVocabulary.find((keyword) => /[<>\r\n]/u.test(keyword));
  if (invalidKeyword) {
    throw new TranscribeError(
      'INVALID_CUSTOM_VOCABULARY',
      'OpenAI custom vocabulary entries cannot contain angle brackets or line breaks.',
    );
  }
}

/** OpenAI expects ISO 639-1 hints; Chinese variants (`zh`, `cmn`, `yue`) collapse to `zh` with an optional region. */
function openAiLanguageHint(languageCode: string): string {
  if (!languageCode) return '';
  const parts = languageCode.toLowerCase().split('-');
  const base = parts[0] ?? '';
  if (base === 'zh' || base === 'cmn' || base === 'yue') {
    const region = parts.find((part) => part === 'cn' || part === 'tw' || part === 'hk');
    if (region) return `zh-${region}`;
    return base === 'yue' ? 'zh-hk' : 'zh';
  }
  return base;
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
