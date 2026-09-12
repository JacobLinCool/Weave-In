import { describe, expect, it } from 'vitest';
import { normalizeDisplayName, parseClientMessage, parsePeerMessage } from '../src/protocol';

describe('meeting signaling protocol', () => {
  it('normalizes human names without accepting control characters', () => {
    expect(normalizeDisplayName('  Ada   Lovelace ')).toBe('Ada Lovelace');
    expect(normalizeDisplayName('')).toBeNull();
    expect(normalizeDisplayName(`Ada${String.fromCharCode(0)}`)).toBeNull();
    expect(normalizeDisplayName('a'.repeat(41))).toBeNull();
  });

  it('accepts only targeted offer, answer, and ICE frames', () => {
    expect(parseClientMessage({
      type: 'signal',
      target: 'peer_target_1234',
      kind: 'offer',
      payload: { type: 'offer', sdp: 'v=0' },
    })).toMatchObject({ kind: 'offer' });
    expect(parseClientMessage({
      type: 'signal',
      target: 'peer_target_1234',
      kind: 'offer',
      payload: { type: 'answer', sdp: 'v=0' },
    })).toBeNull();
    expect(parseClientMessage({ type: 'chat', text: 'not supported' })).toBeNull();
  });
});

describe('peer data-channel protocol', () => {
  it('preserves Markdown whitespace in live chat and history replay', () => {
    const at = '2026-09-12T00:00:00.000Z';
    const text = '    indented code\n\n# Title\n\n- Item\n  - Nested\n\n```js\n\tconst x = 1;\n```\n\nLine  \nBreak';
    expect(parsePeerMessage({ type: 'chat', id: 'md', text, at })).toMatchObject({ text });
    expect(parsePeerMessage({ type: 'history', more: false, entries: [{ kind: 'chat', id: 'md', text, at }] }))
      .toMatchObject({ entries: [{ text }] });
    expect(parsePeerMessage({ type: 'chat', id: 'md', text: 'line\r\nnext\u0000', at })).toMatchObject({ text: 'line\nnext' });
    expect(parsePeerMessage({ type: 'chat', id: 'md', text: '\u0000\t\n', at })).toBeNull();
  });

  it('validates media state announcements', () => {
    expect(parsePeerMessage({
      type: 'state',
      cameraStreamId: 'cam-1',
      screenStreamId: null,
      micOn: true,
      cameraOn: false,
    })).toEqual({ type: 'state', cameraStreamId: 'cam-1', screenStreamId: null, micOn: true, cameraOn: false });
    expect(parsePeerMessage({ type: 'state', cameraStreamId: 1, screenStreamId: null, micOn: true, cameraOn: true })).toBeNull();
  });

  it('bounds chat and transcript text and strips control characters', () => {
    const at = '2026-09-12T00:00:00.000Z';
    expect(parsePeerMessage({ type: 'chat', id: 'm1', text: '  hi there ', at })).toEqual({ type: 'chat', id: 'm1', text: '  hi there ', at, agent: null });
    expect(parsePeerMessage({ type: 'chat', id: 'm1', text: 'hi', at, agent: ' ChatGPT ' })).toMatchObject({ agent: 'ChatGPT' });
    expect(parsePeerMessage({ type: 'chat', id: 'm1', text: 'hi', at, agent: 'x'.repeat(80) })).toMatchObject({ agent: 'x'.repeat(40) });
    expect(parsePeerMessage({ type: 'chat', id: 'm1', text: 'hi', at, agent: 7 })).toBeNull();
    expect(parsePeerMessage({ type: 'chat', id: 'm1', text: '   ', at })).toBeNull();
    expect(parsePeerMessage({ type: 'chat', id: 'm1', text: 'x'.repeat(5_000), at })).toMatchObject({ text: 'x'.repeat(2_000) });
    expect(parsePeerMessage({ type: 'transcript', id: 't1', text: '', at, final: false })).toMatchObject({ text: '', final: false });
    expect(parsePeerMessage({ type: 'transcript', id: 't1', text: 'hello', at: 'not a date', final: true })).toBeNull();
    expect(parsePeerMessage({ type: 'unknown' })).toBeNull();
  });

  it('validates history replays entry by entry', () => {
    const at = '2026-09-12T00:00:00.000Z';
    expect(parsePeerMessage({
      type: 'history',
      more: true,
      entries: [
        { kind: 'chat', id: 'c1', text: ' hi ', at, agent: 'ChatGPT' },
        { kind: 'transcript', id: 't1', text: 'we said this', at },
      ],
    })).toEqual({
      type: 'history',
      more: true,
      entries: [
        { kind: 'chat', id: 'c1', text: ' hi ', at, agent: 'ChatGPT' },
        { kind: 'transcript', id: 't1', text: 'we said this', at },
      ],
    });
    expect(parsePeerMessage({ type: 'history', more: false, entries: [] })).toEqual({ type: 'history', more: false, entries: [] });
    expect(parsePeerMessage({ type: 'history', more: false, entries: [{ kind: 'chat', id: 'c1', text: '', at }] })).toBeNull();
    expect(parsePeerMessage({ type: 'history', more: false, entries: [{ kind: 'file', id: 'f1', at }] })).toBeNull();
    expect(parsePeerMessage({ type: 'history', more: 'yes', entries: [] })).toBeNull();
    expect(parsePeerMessage({ type: 'history', more: false, entries: Array.from({ length: 201 }, (_, index) => ({ kind: 'chat', id: `c${index}`, text: 'x', at })) })).toBeNull();
  });

  it('validates file announcements, requests, and unavailability replies', () => {
    const at = '2026-09-12T00:00:00.000Z';
    expect(parsePeerMessage({ type: 'file', id: 'f1', name: ' notes.md ', size: 1234, mime: 'text/markdown', at }))
      .toEqual({ type: 'file', id: 'f1', name: 'notes.md', size: 1234, mime: 'text/markdown', at });
    expect(parsePeerMessage({ type: 'file', id: 'f1', name: 'blob', size: 10, mime: 'not a mime', at })).toMatchObject({ mime: 'application/octet-stream' });
    expect(parsePeerMessage({ type: 'file', id: 'f1', name: 'huge.bin', size: 300 * 1024 * 1024 + 1, mime: 'application/zip', at })).toBeNull();
    expect(parsePeerMessage({ type: 'file', id: 'f1', name: 'empty', size: 0, mime: 'text/plain', at })).toBeNull();
    expect(parsePeerMessage({ type: 'file', id: 'f1', name: 'x', size: 1.5, mime: 'text/plain', at })).toBeNull();
    expect(parsePeerMessage({ type: 'file-request', id: 'f1', transfer: 't1' })).toEqual({ type: 'file-request', id: 'f1', transfer: 't1' });
    expect(parsePeerMessage({ type: 'file-unavailable', id: 'f1', transfer: 't1' })).toEqual({ type: 'file-unavailable', id: 'f1', transfer: 't1' });
    expect(parsePeerMessage({ type: 'file-request', id: 'f1', transfer: 'bad transfer' })).toBeNull();
  });
});
