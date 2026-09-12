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
const FINALIZATION_TIMEOUT_MS = 5_000;
const MAX_QUEUED_CHUNKS = 100;
const PAUSE_AUDIO_BYTES = 24_000 * 2 * 0.8;
const SPEECH_RMS = 0.005;

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
  readonly #completedItems = new Set<string>();
  #socket: WebSocket | null = null;
  #ready = false;
  #stopping = false;
  #connectionCount = 0;
  #queuedAudio: ArrayBuffer[] = [];
  #rotationTimer: ReturnType<typeof setTimeout> | null = null;
  #fatalErrorReported = false;
  #sentAudioSinceCommit = false;
  #uncommittedAudioBytes = 0;
  #quietAudioBytes = 0;
  #hasSpeech = false;
  #pendingCommits = 0;
  #finalizationPromise: Promise<void> | null = null;
  #finishFinalization: ((error?: TranscribeError) => void) | null = null;
  #stopPromise: Promise<void> | null = null;
  #cancelSetup: (() => void) | null = null;

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
    if (this.#stopping || this.#fatalErrorReported || pcm16.byteLength === 0) return;
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

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    this.#ready = false;
    this.#clearRotationTimer();
    this.#cancelSetup?.();
    this.#stopPromise = this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    try {
      await this.#finalizeCurrentBuffer();
    } catch (error) {
      this.#reportFatal(
        error instanceof TranscribeError ? error.code : 'OPENAI_FINALIZATION_FAILED',
        safeMessage(error, 'OpenAI could not finalize the remaining transcript.'),
      );
    } finally {
      this.#closeConnection();
      this.#queuedAudio = [];
      this.#secrets.clear();
    }
  }

  async #connect(reason: 'initial' | 'rotation'): Promise<void> {
    const credential = await this.#resolveCredential(reason);
    if (this.#stopping || this.#fatalErrorReported) {
      this.#secrets.clear();
      return;
    }
    let channel: WebSocket;
    try {
      channel = this.#dependencies.createWebSocket(REALTIME_ENDPOINT, [
        'realtime', `openai-insecure-api-key.${credential.value}`,
      ]);
    } catch (error) {
      throw new TranscribeError('OPENAI_SETUP_FAILED', this.#redact(safeMessage(error, 'OpenAI Realtime connection failed.')));
    }
    this.#socket = channel;
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
        this.#cancelSetup = null;
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
        this.#cancelSetup = null;
        this.#dependencies.clearTimeout(setupTimer);
        this.#closeConnection();
        reject(error);
      };

      this.#cancelSetup = () => failSetup(new TranscribeError('ABORTED', 'OpenAI setup was stopped.'));
      const reportError = (error: TranscribeError): void => {
        if (!settled) failSetup(error);
        else this.#reportFatal(error.code, error.message);
      };

      channel.addEventListener('open', () => {
        if (channel !== this.#socket) return;
        channel.send(JSON.stringify(this.#createSessionUpdate()));
      });
      channel.addEventListener('message', (event) => {
        this.#handleMessage(event.data, channel, finishSetup, reportError);
      });
      channel.addEventListener('error', () => {
        if (channel !== this.#socket) return;
        const error = new TranscribeError(
          'OPENAI_CONNECTION_FAILED',
          'OpenAI Realtime WebSocket failed.',
        );
        reportError(error);
      });
      channel.addEventListener('close', () => {
        if (channel !== this.#socket) return;
        if (!settled) {
          failSetup(
            new TranscribeError(
              'OPENAI_CONNECTION_CLOSED',
              'OpenAI Realtime closed during setup.',
            ),
          );
        } else {
          this.#reportFatal(
            'OPENAI_CONNECTION_CLOSED',
            'OpenAI Realtime closed the transcription connection.',
          );
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
      delay: 'minimal',
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
            // This model requires client commits instead of server VAD.
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
    reportError: (error: TranscribeError) => void,
  ): void {
    if (channel !== this.#socket || typeof data !== 'string') return;
    try {
      const event = JSON.parse(data) as OpenAiServerEvent;
      if (event.type === 'error') {
        const message = this.#redact(event.error?.message || 'OpenAI Realtime returned an unknown error.');
        const error = new TranscribeError('OPENAI_API_ERROR', message);
        reportError(error);
        return;
      }
      if (event.type === 'session.updated') {
        finishSetup();
        return;
      }
      if (event.type === 'conversation.item.input_audio_transcription.failed') {
        reportError(new TranscribeError(
          'OPENAI_TRANSCRIPTION_FAILED',
          this.#redact(event.error?.message || 'OpenAI could not transcribe an audio segment.'),
        ));
        return;
      }
      if (event.item_id && this.#completedItems.has(event.item_id)) return;
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
        if (item.finalText !== null) return;
        item.finalText = event.transcript;
        this.#completedItems.add(event.item_id);
        if (this.#pendingCommits > 0) this.#pendingCommits -= 1;
        this.#flushCompletedItems();
      }
    } catch {
      const error = new TranscribeError(
        'INVALID_OPENAI_RESPONSE',
        'OpenAI Realtime returned an invalid response.',
      );
      reportError(error);
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
    if (this.#pendingCommits === 0 && this.#items.size === 0) this.#finishFinalization?.();
  }

  #emitInterim(): void {
    const interim = this.#itemOrder
      .map((itemId) => this.#items.get(itemId))
      .filter((item): item is TranscriptItem => item !== undefined)
      .map((item) => item.finalText ?? item.text)
      .filter(Boolean)
      .join('\n');
    this.#callbacks.onInterim(interim);
  }

  #sendAudioNow(channel: WebSocket, pcm16: ArrayBuffer): void {
    channel.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: arrayBufferToBase64(pcm16),
      }),
    );
    this.#sentAudioSinceCommit = true;
    this.#uncommittedAudioBytes += pcm16.byteLength;
    const view = new DataView(pcm16);
    const samples = Math.floor(view.byteLength / 2);
    let energy = 0;
    for (let index = 0; index < samples; index += 1) {
      const sample = view.getInt16(index * 2, true) / 32768;
      energy += sample * sample;
    }
    if (samples > 0 && Math.sqrt(energy / samples) >= SPEECH_RMS) {
      this.#hasSpeech = true;
      this.#quietAudioBytes = 0;
    } else {
      this.#quietAudioBytes += pcm16.byteLength;
    }
    // Commit at a pause, never a fixed boundary that could turn quoted speech
    // into a separate approval command. Low-volume PCM still reaches the model.
    if (this.#hasSpeech && this.#quietAudioBytes >= PAUSE_AUDIO_BYTES) {
      this.#commitAudio(channel);
    }
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
    if (this.#stopping || this.#fatalErrorReported) return;
    this.#ready = false;
    this.#callbacks.onReconnecting?.();
    try {
      await this.#finalizeCurrentBuffer();
      if (this.#stopping || this.#fatalErrorReported) return;
      this.#closeConnection();
      await this.#connect('rotation');
    } catch (error) {
      if (this.#stopping) return;
      this.#reportFatal(
        error instanceof TranscribeError ? error.code : 'OPENAI_ROTATION_FAILED',
        this.#redact(safeMessage(error, 'OpenAI Realtime rotation failed.')),
      );
    }
  }

  #commitAudio(channel: WebSocket): void {
    this.#pendingCommits += 1;
    channel.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    this.#sentAudioSinceCommit = false;
    this.#uncommittedAudioBytes = 0;
    this.#quietAudioBytes = 0;
    this.#hasSpeech = false;
  }

  #finalizeCurrentBuffer(): Promise<void> {
    if (this.#finalizationPromise) return this.#finalizationPromise;
    if (this.#fatalErrorReported) return Promise.resolve();
    const channel = this.#socket;
    if (this.#sentAudioSinceCommit && channel?.readyState === 1) this.#commitAudio(channel);
    // A recent commit may not even have an item ID yet. Wait for its completion,
    // not just for unsent audio or the items that have already emitted deltas.
    if (this.#pendingCommits === 0 && this.#items.size === 0) return Promise.resolve();
    this.#finalizationPromise = new Promise<void>((resolve, reject) => {
      const timer = this.#dependencies.setTimeout(() => {
        this.#finishFinalization?.(new TranscribeError(
          'OPENAI_FINALIZATION_TIMEOUT',
          'OpenAI did not finalize the remaining audio within 5 seconds. The transcript may be incomplete.',
        ));
      }, FINALIZATION_TIMEOUT_MS);
      this.#finishFinalization = (error) => {
        this.#dependencies.clearTimeout(timer);
        this.#finishFinalization = null;
        this.#finalizationPromise = null;
        if (error) reject(error);
        else resolve();
      };
    });
    return this.#finalizationPromise;
  }

  #closeConnection(): void {
    const channel = this.#socket;
    this.#socket = null;
    this.#ready = false;
    this.#items.clear();
    this.#itemOrder.length = 0;
    this.#completedItems.clear();
    this.#pendingCommits = 0;
    this.#sentAudioSinceCommit = false;
    this.#uncommittedAudioBytes = 0;
    this.#quietAudioBytes = 0;
    this.#hasSpeech = false;
    if (channel && channel.readyState < 2) channel.close(1000, 'Transcription stopped');
  }

  #reportFatal(code: string, message: string): void {
    if (this.#fatalErrorReported) return;
    this.#fatalErrorReported = true;
    this.#ready = false;
    this.#clearRotationTimer();
    const redacted = this.#redact(message);
    this.#finishFinalization?.(new TranscribeError(code, redacted));
    this.#callbacks.onFatalError(code, redacted);
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
