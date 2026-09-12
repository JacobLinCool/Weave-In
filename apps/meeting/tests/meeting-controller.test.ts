import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeetingController, type MeetingControllerEvents } from '../src/meeting-controller';
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
  vi.unstubAllGlobals();
  Socket.instances = [];
});
describe('signaling recovery', () => {
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
    Socket.instances[2]!.welcome('reconnected-token');
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onConnected).toHaveBeenCalledTimes(2);
    expect(controller.sessionToken).toBe('reconnected-token');
    expect(events.onError).not.toHaveBeenCalled();
    Socket.instances[2]!.close();
    controller.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(Socket.instances).toHaveLength(3);
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
