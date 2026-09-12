import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectWithIdentityRecovery, MeetingController, RoomAdmissionError, type MeetingControllerEvents } from '../src/meeting-controller';
class Socket extends EventTarget {
  static instances: Socket[] = [];
  static OPEN = 1;
  readyState = 1;
  constructor(readonly url: string) {
    super();
    Socket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  welcome(sessionToken = 'initial-token') {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'welcome',
          sessionToken,
          self: { peerId: 'a'.repeat(32), name: 'Alice', isHost: true },
          peers: [],
          startedAt: 100,
          serverTime: 200,
        }),
      }),
    );
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Socket.instances = [];
});
describe('signaling recovery', () => {
  it('recovers through real controller events before the rejected socket finishes closing', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { location: { href: 'https://meeting.test' } });
    vi.stubGlobal('WebSocket', Socket);
    const events = { onConnected: vi.fn(), onReconnecting: vi.fn(), onError: vi.fn() } as unknown as MeetingControllerEvents;
    const controller = new MeetingController([], events);
    const resetSession = vi.fn();
    const ready = connectWithIdentityRecovery(controller, {
      roomCode: 'ABCDEF', action: 'join', displayName: 'Sky', peerId: 'a'.repeat(32),
    }, resetSession);
    const rejectedSocket = Socket.instances[0]!;
    vi.spyOn(rejectedSocket, 'close').mockImplementation(() => { rejectedSocket.readyState = 2; });
    rejectedSocket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'error', code: 'DUPLICATE_PEER', message: 'Already connected.' }),
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(Socket.instances).toHaveLength(2);
    expect(resetSession).toHaveBeenCalledTimes(1);
    expect(new URL(Socket.instances[1]!.url).searchParams.get('peerId')).not.toBe('a'.repeat(32));
    Socket.instances[1]!.welcome();
    await ready;
    rejectedSocket.dispatchEvent(new Event('close'));
    rejectedSocket.dispatchEvent(new Event('error'));
    expect(events.onConnected).toHaveBeenCalledTimes(1);
    expect(events.onReconnecting).not.toHaveBeenCalled();
    expect(events.onError).not.toHaveBeenCalled();
    expect(Socket.instances[1]!.readyState).toBe(1);
    controller.close();
  });

  it('retries an initial duplicate identity once, resetting copied history before admission', async () => {
    const resetSession = vi.fn();
    const args = { roomCode: 'ABCDEF', action: 'join' as const, displayName: 'Sky', peerId: 'a'.repeat(32) };
    const connect = vi.fn()
      .mockRejectedValueOnce(new RoomAdmissionError('DUPLICATE_PEER', 'Already connected.'))
      .mockImplementationOnce(async () => { expect(resetSession).toHaveBeenCalledTimes(1); });
    await connectWithIdentityRecovery({ connect }, args, resetSession);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[0]![0]).toEqual(args);
    const retry = connect.mock.calls[1]![0];
    expect(retry).toMatchObject({ roomCode: args.roomCode, action: 'join', displayName: 'Sky' });
    expect(retry.peerId).not.toBe(args.peerId);
    expect(retry.peerId).toMatch(/^[a-f0-9]{32}$/u);
  });

  it.each(['ROOM_FULL', 'ROOM_EXISTS', 'SIGNALING_ERROR'])('does not switch identity for %s', async (code) => {
    const error = new RoomAdmissionError(code, 'Unable to join.');
    const connect = vi.fn().mockRejectedValue(error);
    const resetSession = vi.fn();
    await expect(connectWithIdentityRecovery({ connect }, {
      roomCode: 'ABCDEF', action: 'join', displayName: 'Sky', peerId: 'a'.repeat(32),
    }, resetSession)).rejects.toBe(error);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(resetSession).not.toHaveBeenCalled();
  });

  it('surfaces a failed fresh-identity retry instead of looping', async () => {
    const error = new RoomAdmissionError('DUPLICATE_PEER', 'Already connected.');
    const connect = vi.fn().mockRejectedValue(error);
    const resetSession = vi.fn();
    await expect(connectWithIdentityRecovery({ connect }, {
      roomCode: 'ABCDEF', action: 'join', displayName: 'Sky', peerId: 'a'.repeat(32),
    }, resetSession)).rejects.toBe(error);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(resetSession).toHaveBeenCalledTimes(1);
  });

  it('preserves the admission error, releases the socket, and permits a fresh attempt', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { location: { href: 'https://meeting.test' } });
    vi.stubGlobal('WebSocket', Socket);
    const events = { onConnected: vi.fn(), onReconnecting: vi.fn(), onError: vi.fn() } as unknown as MeetingControllerEvents;
    const controller = new MeetingController([], events);
    const args = { roomCode: 'ABCDEF', action: 'join' as const, displayName: 'Alice', peerId: 'a'.repeat(32) };
    const ready = controller.connect(args);
    const rejected = expect(ready).rejects.toThrow('This room is full (8 people).');
    Socket.instances[0]!.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'error', code: 'ROOM_FULL', message: 'This room is full (8 people).' }),
    }));
    await rejected;
    Socket.instances[0]!.dispatchEvent(new Event('error'));
    Socket.instances[0]!.welcome();
    await vi.advanceTimersByTimeAsync(20000);
    expect(events.onConnected).not.toHaveBeenCalled();
    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onReconnecting).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const retry = controller.connect(args);
    Socket.instances[1]!.welcome();
    await retry;
    expect(events.onConnected).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it.each(['error', 'close', 'timeout'])('cleans up a failed initial connection after %s', async (failure) => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { location: { href: 'https://meeting.test' } });
    vi.stubGlobal('WebSocket', Socket);
    const events = { onConnected: vi.fn(), onReconnecting: vi.fn(), onError: vi.fn() } as unknown as MeetingControllerEvents;
    const controller = new MeetingController([], events);
    const ready = controller.connect({ roomCode: 'ABCDEF', action: 'join', displayName: 'Alice', peerId: 'a'.repeat(32) });
    const rejected = expect(ready).rejects.toThrow(failure === 'timeout' ? 'timed out' : failure === 'close' ? 'connection closed' : 'Unable to connect');
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(10000);
    else Socket.instances[0]!.dispatchEvent(new Event(failure));
    await rejected;
    expect(Socket.instances[0]!.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(events.onReconnecting).not.toHaveBeenCalled();
    controller.close();
  });

  it('reports errors after admission without disconnecting the room', async () => {
    vi.stubGlobal('window', { location: { href: 'https://meeting.test' } });
    vi.stubGlobal('WebSocket', Socket);
    const events = { onConnected: vi.fn(), onError: vi.fn() } as unknown as MeetingControllerEvents;
    const controller = new MeetingController([], events);
    const ready = controller.connect({ roomCode: 'ABCDEF', action: 'join', displayName: 'Alice', peerId: 'a'.repeat(32) });
    Socket.instances[0]!.welcome();
    await ready;
    Socket.instances[0]!.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'error', code: 'PEER_NOT_FOUND', message: 'The peer left.' }),
    }));
    expect(events.onError).toHaveBeenCalledWith('PEER_NOT_FOUND', 'The peer left.');
    expect(Socket.instances[0]!.readyState).toBe(1);
    controller.close();
  });

  it('rejoins with the same identity after socket loss, backs off, and stops retrying after leave', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { location: { href: 'https://meeting.test' } });
    vi.stubGlobal('WebSocket', Socket);
    const events = {
      onConnected: vi.fn(),
      onReconnecting: vi.fn(),
      onError: vi.fn(),
    } as unknown as MeetingControllerEvents;
    const controller = new MeetingController([], events);
    const ready = controller.connect({
      roomCode: 'ABCDEF',
      action: 'create',
      displayName: 'Alice',
      peerId: 'a'.repeat(32),
    });
    Socket.instances[0]!.welcome();
    await ready;
    expect(controller.sessionToken).toBe('initial-token');
    Socket.instances[0]!.close();
    expect(events.onReconnecting).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(String(Socket.instances[1]!.url)).toContain('action=join');
    expect(String(Socket.instances[1]!.url)).toContain('peerId=' + 'a'.repeat(32));
    Socket.instances[1]!.close();
    await vi.advanceTimersByTimeAsync(2000);
    Socket.instances[2]!.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'error', code: 'DUPLICATE_PEER', message: 'Already connected.' }),
    }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(String(Socket.instances[3]!.url)).toContain('peerId=' + 'a'.repeat(32));
    Socket.instances[3]!.welcome('reconnected-token');
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onConnected).toHaveBeenCalledTimes(2);
    expect(controller.sessionToken).toBe('reconnected-token');
    expect(events.onError).not.toHaveBeenCalled();
    Socket.instances[3]!.close();
    controller.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(Socket.instances).toHaveLength(4);
    expect(controller.sessionToken).toBe('');
  });
  it('ignores a welcome from an obsolete socket', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { location: { href: 'https://meeting.test' } });
    vi.stubGlobal('WebSocket', Socket);
    const events = {
      onConnected: vi.fn(),
      onReconnecting: vi.fn(),
      onError: vi.fn(),
    } as unknown as MeetingControllerEvents;
    const controller = new MeetingController([], events);
    const ready = controller.connect({
      roomCode: 'ABCDEF',
      action: 'join',
      displayName: 'Alice',
      peerId: 'a'.repeat(32),
    });
    Socket.instances[0]!.welcome();
    await ready;
    Socket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(1000);
    Socket.instances[0]!.welcome();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onConnected).toHaveBeenCalledTimes(1);
    controller.close();
  });
});
