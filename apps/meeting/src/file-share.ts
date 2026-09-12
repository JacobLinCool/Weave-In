import { DEFAULT_FILE_MIME, FILE_CHANNEL_PREFIX, type PeerMessage, type SharedFileMeta } from './protocol';

/** Chunk size well inside the 256 KiB message limit current browsers negotiate for data channels. */
export const FILE_CHUNK_BYTES = 64 * 1024;
/** Bytes read from disk per pass; each block is cut into `FILE_CHUNK_BYTES` messages. */
const READ_BLOCK_BYTES = 4 * 1024 * 1024;
const HIGH_WATER_BYTES = 2 * 1024 * 1024;
const LOW_WATER_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const PROGRESS_INTERVAL_MS = 120;
const SELF = 'self';

export type SharedFileStatus = 'available' | 'downloading' | 'ready' | 'unavailable' | 'error';

export interface SharedFile extends SharedFileMeta {
  /** Peer id of the participant who shared the file, or `'self'`. */
  owner: string;
  own: boolean;
  status: SharedFileStatus;
  received: number;
  blob: Blob | null;
  error: string | null;
}

export interface FileTransport {
  send(peerId: string, message: PeerMessage): boolean;
  broadcast(message: PeerMessage): void;
  openChannel(peerId: string, label: string): TransferChannel | null;
}

/** The slice of RTCDataChannel a transfer uses, so transfers can be exercised with fakes. */
export interface TransferChannel extends EventTarget {
  readonly label: string;
  binaryType: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  readonly readyState: string;
  send(data: ArrayBuffer): void;
  close(): void;
}

interface IncomingTransfer {
  fileId: string;
  owner: string;
  channel: TransferChannel | null;
  timer: ReturnType<typeof setTimeout> | null;
  chunks: ArrayBuffer[];
  received: number;
  resolve(blob: Blob): void;
  reject(error: Error): void;
}

/**
 * Peer-to-peer file sharing for one meeting. A shared file is announced by metadata
 * only; the bytes leave the owner's browser when a participant asks for them, over a
 * dedicated data channel per transfer, and are kept in memory once received.
 */
export class FileShare {
  readonly #transport: FileTransport;
  readonly #onChange: (files: Record<string, SharedFile>) => void;
  readonly #files = new Map<string, SharedFile>();
  readonly #local = new Map<string, File>();
  readonly #incoming = new Map<string, IncomingTransfer>();
  readonly #outgoing = new Set<TransferChannel>();
  readonly #pending = new Map<string, Promise<Blob>>();
  #progressTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(transport: FileTransport, onChange: (files: Record<string, SharedFile>) => void) {
    this.#transport = transport;
    this.#onChange = onChange;
  }

  files(): SharedFile[] {
    return [...this.#files.values()];
  }

  get(id: string): SharedFile | undefined {
    return this.#files.get(id);
  }

  /** Announces a local file to everyone; nothing is sent until a participant opens it. */
  share(file: File, at = new Date().toISOString()): SharedFile {
    const meta: SharedFileMeta = {
      id: crypto.randomUUID(),
      name: file.name || 'file',
      size: file.size,
      mime: file.type || DEFAULT_FILE_MIME,
      at,
    };
    this.#local.set(meta.id, file);
    const shared: SharedFile = { ...meta, owner: SELF, own: true, status: 'ready', received: file.size, blob: file, error: null };
    this.#files.set(meta.id, shared);
    this.#transport.broadcast({ type: 'file', ...meta });
    this.#emit();
    return shared;
  }

  /** Re-announces this participant's files to a peer whose channel just opened (late joiners). */
  announceTo(peerId: string): void {
    for (const [id, file] of this.#local) {
      const shared = this.#files.get(id);
      if (!shared) continue;
      this.#transport.send(peerId, { type: 'file', id, name: shared.name, size: file.size, mime: shared.mime, at: shared.at });
    }
  }

  /** Returns the newly announced file, or null when the message was a request, a reply, or a duplicate. */
  handleMessage(peerId: string, message: PeerMessage): SharedFile | null {
    switch (message.type) {
      case 'file': {
        if (this.#files.has(message.id)) return null;
        const shared: SharedFile = {
          id: message.id,
          name: message.name,
          size: message.size,
          mime: message.mime,
          at: message.at,
          owner: peerId,
          own: false,
          status: 'available',
          received: 0,
          blob: null,
          error: null,
        };
        this.#files.set(message.id, shared);
        this.#emit();
        return shared;
      }
      case 'file-request':
        void this.#serve(peerId, message.id, message.transfer);
        return null;
      case 'file-unavailable': {
        const transfer = this.#incoming.get(message.transfer);
        if (transfer && transfer.owner === peerId) this.#fail(message.transfer, 'The participant who shared this file no longer has it.');
        return null;
      }
      default:
        return null;
    }
  }

  /** Accepts an incoming transfer channel; returns false when the channel is not a file transfer. */
  handleChannel(peerId: string, channel: TransferChannel): boolean {
    if (!channel.label.startsWith(FILE_CHANNEL_PREFIX)) return false;
    const transferId = channel.label.slice(FILE_CHANNEL_PREFIX.length);
    const transfer = this.#incoming.get(transferId);
    if (!transfer || transfer.owner !== peerId || transfer.channel) {
      channel.close();
      return true;
    }
    if (transfer.timer) clearTimeout(transfer.timer);
    transfer.timer = null;
    transfer.channel = channel;
    channel.binaryType = 'arraybuffer';
    const file = this.#files.get(transfer.fileId);
    channel.addEventListener('message', (event) => {
      const data = (event as MessageEvent).data as unknown;
      if (!(data instanceof ArrayBuffer)) {
        this.#fail(transferId, 'The transfer carried unexpected data.');
        return;
      }
      transfer.chunks.push(data);
      transfer.received += data.byteLength;
      if (!file) return;
      if (transfer.received > file.size) {
        this.#fail(transferId, 'The transfer sent more data than announced.');
        return;
      }
      file.received = transfer.received;
      if (transfer.received === file.size) {
        this.#finish(transferId, new Blob(transfer.chunks, { type: file.mime }));
        return;
      }
      this.#scheduleEmit();
    });
    channel.addEventListener('close', () => {
      if (this.#incoming.has(transferId)) this.#fail(transferId, 'The transfer was interrupted.');
    });
    channel.addEventListener('error', () => {
      if (this.#incoming.has(transferId)) this.#fail(transferId, 'The transfer failed.');
    });
    return true;
  }

  /** Fetches a file from its owner, or returns it immediately when it is already in memory. */
  download(id: string): Promise<Blob> {
    const file = this.#files.get(id);
    if (!file) return Promise.reject(new Error('That file is not part of this meeting.'));
    if (file.blob) return Promise.resolve(file.blob);
    const inflight = this.#pending.get(id);
    if (inflight) return inflight;
    if (file.status === 'unavailable') return Promise.reject(new Error(file.error ?? 'This file is no longer available.'));
    const promise = new Promise<Blob>((resolve, reject) => {
      const transferId = crypto.randomUUID();
      const transfer: IncomingTransfer = {
        fileId: id,
        owner: file.owner,
        channel: null,
        timer: setTimeout(() => this.#fail(transferId, 'The participant who shared this file did not respond.'), REQUEST_TIMEOUT_MS),
        chunks: [],
        received: 0,
        resolve,
        reject,
      };
      this.#incoming.set(transferId, transfer);
      file.status = 'downloading';
      file.received = 0;
      file.error = null;
      this.#emit();
      if (!this.#transport.send(file.owner, { type: 'file-request', id, transfer: transferId })) {
        this.#fail(transferId, 'The participant who shared this file is not reachable.');
      }
    });
    this.#pending.set(id, promise);
    promise.catch(() => undefined).finally(() => this.#pending.delete(id));
    return promise;
  }

  peerLeft(peerId: string): void {
    for (const [transferId, transfer] of [...this.#incoming]) {
      if (transfer.owner === peerId) this.#fail(transferId, 'The participant who shared this file left the meeting.');
    }
    let changed = false;
    for (const file of this.#files.values()) {
      if (file.owner !== peerId || file.blob) continue;
      file.status = 'unavailable';
      file.error = 'The participant who shared this file left the meeting.';
      changed = true;
    }
    if (changed) this.#emit();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const transferId of [...this.#incoming.keys()]) this.#fail(transferId, 'The meeting ended.');
    for (const channel of this.#outgoing) channel.close();
    this.#outgoing.clear();
    if (this.#progressTimer) clearTimeout(this.#progressTimer);
    this.#progressTimer = null;
    this.#files.clear();
    this.#local.clear();
  }

  async #serve(peerId: string, fileId: string, transferId: string): Promise<void> {
    const file = this.#local.get(fileId);
    const channel = file ? this.#transport.openChannel(peerId, FILE_CHANNEL_PREFIX + transferId) : null;
    if (!file || !channel) {
      this.#transport.send(peerId, { type: 'file-unavailable', id: fileId, transfer: transferId });
      return;
    }
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER_BYTES;
    this.#outgoing.add(channel);
    let closed = false;
    const markClosed = (): void => {
      closed = true;
      this.#outgoing.delete(channel);
    };
    channel.addEventListener('close', markClosed);
    channel.addEventListener('error', markClosed);
    try {
      await waitForOpen(channel);
      for (let start = 0; start < file.size && !closed; start += READ_BLOCK_BYTES) {
        const block = await file.slice(start, Math.min(start + READ_BLOCK_BYTES, file.size)).arrayBuffer();
        for (let offset = 0; offset < block.byteLength && !closed; offset += FILE_CHUNK_BYTES) {
          if (channel.bufferedAmount > HIGH_WATER_BYTES) await waitForDrain(channel);
          if (closed) break;
          channel.send(block.slice(offset, Math.min(offset + FILE_CHUNK_BYTES, block.byteLength)));
        }
      }
      // The receiver closes the channel once every byte has arrived; closing here could drop buffered data.
    } catch {
      if (!closed) channel.close();
    }
  }

  #finish(transferId: string, blob: Blob): void {
    const transfer = this.#incoming.get(transferId);
    if (!transfer) return;
    this.#incoming.delete(transferId);
    const file = this.#files.get(transfer.fileId);
    if (file) {
      file.status = 'ready';
      file.received = file.size;
      file.blob = blob;
      file.error = null;
    }
    transfer.channel?.close();
    transfer.resolve(blob);
    this.#emit();
  }

  #fail(transferId: string, message: string): void {
    const transfer = this.#incoming.get(transferId);
    if (!transfer) return;
    this.#incoming.delete(transferId);
    if (transfer.timer) clearTimeout(transfer.timer);
    const file = this.#files.get(transfer.fileId);
    if (file && !file.blob) {
      file.status = 'error';
      file.received = 0;
      file.error = message;
    }
    transfer.channel?.close();
    transfer.reject(new Error(message));
    this.#emit();
  }

  #scheduleEmit(): void {
    if (this.#progressTimer) return;
    this.#progressTimer = setTimeout(() => {
      this.#progressTimer = null;
      this.#emit();
    }, PROGRESS_INTERVAL_MS);
  }

  #emit(): void {
    if (this.#closed) return;
    this.#onChange(Object.fromEntries([...this.#files].map(([id, file]) => [id, { ...file }])));
  }
}

function waitForOpen(channel: TransferChannel): Promise<void> {
  if (channel.readyState === 'open') return Promise.resolve();
  if (channel.readyState !== 'connecting') return Promise.reject(new Error('The transfer channel is closed.'));
  return new Promise((resolve, reject) => {
    const settle = (): void => {
      channel.removeEventListener('open', onOpen);
      channel.removeEventListener('close', onClose);
      channel.removeEventListener('error', onClose);
    };
    const onOpen = (): void => {
      settle();
      resolve();
    };
    const onClose = (): void => {
      settle();
      reject(new Error('The transfer channel closed before opening.'));
    };
    channel.addEventListener('open', onOpen);
    channel.addEventListener('close', onClose);
    channel.addEventListener('error', onClose);
  });
}

function waitForDrain(channel: TransferChannel): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      channel.removeEventListener('bufferedamountlow', done);
      channel.removeEventListener('close', done);
      channel.removeEventListener('error', done);
      resolve();
    };
    channel.addEventListener('bufferedamountlow', done);
    channel.addEventListener('close', done);
    channel.addEventListener('error', done);
  });
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
