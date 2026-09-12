import { describe, expect, it } from 'vitest';
import { FILE_CHUNK_BYTES, FileShare, formatBytes, type FileTransport, type SharedFile, type TransferChannel } from '../src/file-share';
import { parsePeerMessage, type PeerMessage } from '../src/protocol';

class FakeChannel extends EventTarget implements TransferChannel {
  binaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState = 'connecting';
  peer: FakeChannel | null = null;
  readonly sent: ArrayBuffer[] = [];

  constructor(readonly label: string) {
    super();
  }

  send(data: ArrayBuffer): void {
    if (this.readyState !== 'open') throw new Error('The channel is not open.');
    this.sent.push(data);
    const peer = this.peer;
    queueMicrotask(() => {
      if (peer?.readyState === 'open') peer.dispatchEvent(new MessageEvent('message', { data }));
    });
  }

  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
    this.peer?.close();
  }
}

interface Party {
  share: FileShare;
  snapshots: Record<string, SharedFile>[];
  outbound: PeerMessage[];
}

/** Two participants wired directly to each other: messages hop over a microtask, channels come in pairs. */
function pair(): { a: Party; b: Party } {
  const parties = {} as { a: Party; b: Party };
  const wire = (from: 'a' | 'b', to: 'a' | 'b'): FileTransport => ({
    send: (peerId, message) => {
      if (peerId !== to) return false;
      parties[from].outbound.push(message);
      const parsed = parsePeerMessage(JSON.parse(JSON.stringify(message)));
      queueMicrotask(() => {
        if (parsed) parties[to].share.handleMessage(from, parsed);
      });
      return true;
    },
    broadcast: (message) => {
      wire(from, to).send(to, message);
    },
    openChannel: (peerId, label) => {
      if (peerId !== to) return null;
      const local = new FakeChannel(label);
      const remote = new FakeChannel(label);
      local.peer = remote;
      remote.peer = local;
      queueMicrotask(() => {
        parties[to].share.handleChannel(from, remote);
        remote.open();
        local.open();
      });
      return local;
    },
  });
  for (const [name, other] of [['a', 'b'], ['b', 'a']] as const) {
    const party: Party = { snapshots: [], outbound: [], share: null as unknown as FileShare };
    party.share = new FileShare(wire(name, other), (files) => party.snapshots.push(files));
    parties[name] = party;
  }
  return parties;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('peer-to-peer file sharing', () => {
  it('announces metadata only, then streams the bytes on request over a dedicated channel', async () => {
    const { a, b } = pair();
    const bytes = new Uint8Array(FILE_CHUNK_BYTES * 2 + 1234).map((_, index) => index % 251);
    const shared = a.share.share(new File([bytes], 'notes.bin', { type: 'application/octet-stream' }), '2026-09-12T00:00:00.000Z');
    expect(shared).toMatchObject({ own: true, status: 'ready', size: bytes.length });
    expect(a.outbound).toEqual([{ type: 'file', id: shared.id, name: 'notes.bin', size: bytes.length, mime: 'application/octet-stream', at: '2026-09-12T00:00:00.000Z' }]);
    await settle();
    const announced = b.share.get(shared.id);
    expect(announced).toMatchObject({ owner: 'a', own: false, status: 'available', received: 0, blob: null });
    expect(b.outbound).toEqual([]);

    const blob = await b.share.download(shared.id);
    expect(blob.size).toBe(bytes.length);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(b.outbound).toEqual([{ type: 'file-request', id: shared.id, transfer: expect.any(String) }]);
    expect(b.share.get(shared.id)).toMatchObject({ status: 'ready', received: bytes.length });
    const statuses = b.snapshots.map((snapshot) => snapshot[shared.id]?.status);
    expect(statuses).toContain('downloading');
    expect(statuses[statuses.length - 1]).toBe('ready');
    expect(await b.share.download(shared.id)).toBe(blob);
    expect(b.outbound).toHaveLength(1);
  });

  it('answers requests for unknown files with file-unavailable and reports it to the requester', async () => {
    const { a, b } = pair();
    b.share.handleMessage('a', { type: 'file', id: 'ghost', name: 'ghost.txt', size: 3, mime: 'text/plain', at: '2026-09-12T00:00:00.000Z' });
    await expect(b.share.download('ghost')).rejects.toThrow('no longer has it');
    expect(a.outbound).toEqual([{ type: 'file-unavailable', id: 'ghost', transfer: expect.any(String) }]);
    expect(b.share.get('ghost')).toMatchObject({ status: 'error' });
    await settle();
  });

  it('marks files unavailable and fails transfers when their owner leaves', async () => {
    const { b } = pair();
    b.share.handleMessage('a', { type: 'file', id: 'gone', name: 'gone.txt', size: 3, mime: 'text/plain', at: '2026-09-12T00:00:00.000Z' });
    const pending = b.share.download('gone');
    b.share.peerLeft('a');
    await expect(pending).rejects.toThrow('left the meeting');
    expect(b.share.get('gone')).toMatchObject({ status: 'unavailable' });
    await expect(b.share.download('gone')).rejects.toThrow('left the meeting');
  });

  it('re-announces its own files to peers that arrive later', () => {
    const { a } = pair();
    const shared = a.share.share(new File(['hello'], 'hello.txt', { type: 'text/plain' }));
    a.outbound.length = 0;
    a.share.announceTo('b');
    expect(a.outbound).toEqual([{ type: 'file', id: shared.id, name: 'hello.txt', size: 5, mime: 'text/plain', at: shared.at }]);
    expect(a.share.handleMessage('b', { type: 'file', id: shared.id, name: 'hello.txt', size: 5, mime: 'text/plain', at: shared.at })).toBeNull();
  });

  it('restores downloads when the original owner reconnects without duplicating the announcement', async () => {
    const { a, b } = pair();
    const shared = a.share.share(new File(['hello'], 'hello.txt', { type: 'text/plain' }));
    await settle();
    b.share.peerLeft('a');
    const announcement = a.outbound[0]!;
    expect(b.share.handleMessage('other-peer', announcement)).toBeNull();
    expect(b.share.get(shared.id)?.status).toBe('unavailable');

    expect(b.share.handleMessage('a', announcement)).toBeNull();
    expect(b.snapshots.at(-1)?.[shared.id]).toMatchObject({ status: 'available', received: 0, error: null });
    expect(b.share.files()).toHaveLength(1);
    const blob = await b.share.download(shared.id);
    expect(await blob.text()).toBe('hello');
    b.share.peerLeft('a');
    a.share.announceTo('b');
    await settle();
    expect(b.share.get(shared.id)).toMatchObject({ status: 'ready', blob });
    a.share.close();
    b.share.close();
  });

  it('formats sizes for humans', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(20 * 1024)).toBe('20 KB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(formatBytes(300 * 1024 * 1024)).toBe('300 MB');
  });
});
