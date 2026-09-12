import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  message(message: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  welcome(peers: { peerId: string; name: string; isHost: boolean }[] = []) {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'welcome',
          self: { peerId: 'a'.repeat(32), name: 'Alice', isHost: true },
          peers,
          startedAt: 100,
          serverTime: 200,
        }),
      }),
    );
  }
}
const HOUR = 3600000;
const args = { roomCode: 'ABCDEF', action: 'create' as const, displayName: 'Alice', peerId: 'a'.repeat(32) };
const peer = { peerId: 'b'.repeat(32), name: 'Bob', isHost: false };
const credentials = (version = 'initial') => ({ ok: true, iceServers: [{ urls: ['turn:relay.test:3478?transport=udp', 'turns:relay.test:443?transport=tcp'], username: version, credential: 'test-credential' }], expiresAt: Date.now() + HOUR });

class PeerConnection extends EventTarget {
  static instances: PeerConnection[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  restartIce = vi.fn();
  setConfiguration = vi.fn((configuration: RTCConfiguration) => { this.configuration = configuration; });
  setLocalDescription = vi.fn(async () => { this.localDescription = { type: 'offer', sdp: 'test-offer' }; });
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => { this.remoteDescription = description; });
  addIceCandidate = vi.fn(async () => {});
  constructor(public configuration: RTCConfiguration) {
    super();
    PeerConnection.instances.push(this);
  }
  getConfiguration() { return this.configuration; }
  createDataChannel() { return Object.assign(new EventTarget(), { readyState: 'connecting', close: vi.fn() }); }
  close() { this.connectionState = 'closed'; this.iceConnectionState = 'closed'; }
  changeIce(state: RTCIceConnectionState) {
    this.iceConnectionState = state;
    this.connectionState = state === 'completed' ? 'connected' : state === 'checking' ? 'connecting' : state;
    this.dispatchEvent(new Event('iceconnectionstatechange'));
  }
}

function events(): MeetingControllerEvents {
  return {
    onConnected: vi.fn(), onReconnecting: vi.fn(), onError: vi.fn(), onIceRecovered: vi.fn(),
    onPeerJoined: vi.fn(), onPeerLeft: vi.fn(), onRemoteStream: vi.fn(), onRemoteStreamEnded: vi.fn(),
    onPeerChannelOpen: vi.fn(), onPeerMessage: vi.fn(), onPeerChannel: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  vi.stubGlobal('window', { location: { href: 'https://meeting.test' } });
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('RTCPeerConnection', PeerConnection);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(credentials())));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Socket.instances = [];
  PeerConnection.instances = [];
  vi.restoreAllMocks();
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
    await vi.advanceTimersByTimeAsync(0);
    Socket.instances[0]!.welcome();
    await ready;
    Socket.instances[0]!.close();
    expect(events.onReconnecting).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(String(Socket.instances[1]!.url)).toContain('action=join');
    expect(String(Socket.instances[1]!.url)).toContain('peerId=' + 'a'.repeat(32));
    Socket.instances[1]!.close();
    await vi.advanceTimersByTimeAsync(2000);
    Socket.instances[2]!.welcome();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onConnected).toHaveBeenCalledTimes(2);
    expect(events.onError).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    Socket.instances[2]!.close();
    controller.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(Socket.instances).toHaveLength(3);
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
    await vi.advanceTimersByTimeAsync(0);
    Socket.instances[0]!.welcome();
    await ready;
    Socket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    Socket.instances[0]!.welcome();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onConnected).toHaveBeenCalledTimes(1);
    controller.close();
  });
});

describe('relay-backed peer connections', () => {
  async function meeting() {
    const callbacks = events();
    const controller = new MeetingController([], callbacks);
    const ready = controller.connect(args);
    await vi.advanceTimersByTimeAsync(0);
    const socket = Socket.instances[0]!;
    socket.welcome([peer]);
    await ready;
    return { controller, callbacks, socket, connection: PeerConnection.instances[0]! };
  }

  it('provisions credentials before opening signaling or any peer connection', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    const controller = new MeetingController([], events());
    const ready = controller.connect(args);
    expect(Socket.instances).toHaveLength(0);
    expect(PeerConnection.instances).toHaveLength(0);
    resolve(Response.json(credentials()));
    await vi.advanceTimersByTimeAsync(0);
    Socket.instances[0]!.welcome([peer]);
    await ready;
    expect(PeerConnection.instances[0]!.configuration).toEqual({ iceServers: credentials().iceServers });
    expect(fetch).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it('rejects provisioning failures with a readable error and allows joining again', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ok: false, code: 'ICE_SERVICE_UNAVAILABLE' }, { status: 503 })).mockImplementation(async () => Response.json(credentials()));
    vi.stubGlobal('fetch', fetch);
    const callbacks = events();
    const controller = new MeetingController([], callbacks);
    await expect(controller.connect(args)).rejects.toThrow('administrator');
    expect(callbacks.onError).toHaveBeenCalledWith('ICE_SERVICE_UNAVAILABLE', expect.stringContaining('administrator'));
    expect(Socket.instances).toHaveLength(0);
    expect(PeerConnection.instances).toHaveLength(0);
    const ready = controller.connect(args);
    await vi.advanceTimersByTimeAsync(0);
    Socket.instances[0]!.welcome([peer]);
    await ready;
    controller.close();
  });

  it('updates existing and late peer connections when credentials renew', async () => {
    const { controller, socket, connection } = await meeting();
    vi.mocked(fetch).mockImplementation(async () => Response.json(credentials('renewed')));
    await vi.advanceTimersByTimeAsync(HOUR - 300000);
    expect(connection.setConfiguration).toHaveBeenCalledWith({ iceServers: credentials('renewed').iceServers });
    socket.message({ type: 'peer-joined', peer: { ...peer, peerId: 'c'.repeat(32) } });
    await vi.advanceTimersByTimeAsync(0);
    expect(PeerConnection.instances[1]!.configuration.iceServers).toEqual(credentials('renewed').iceServers);
    expect(fetch).toHaveBeenCalledTimes(2);
    controller.close();
  });

  it('restarts healthy ICE connections after renewed credentials replace their configuration', async () => {
    const { controller, connection } = await meeting();
    connection.changeIce('connected');
    vi.mocked(fetch).mockImplementation(async () => Response.json(credentials('renewed')));
    await vi.advanceTimersByTimeAsync(HOUR - 300000 + 1);
    expect(connection.restartIce).toHaveBeenCalledTimes(1);
    expect(connection.setConfiguration.mock.invocationCallOrder[0]).toBeLessThan(connection.restartIce.mock.invocationCallOrder[0]!);
    controller.close();
  });

  it('announces recovery of the precise provisioning error after a later renewal succeeds', async () => {
    const { controller, callbacks } = await meeting();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(HOUR - 300000 + 3000);
    const [code, message] = vi.mocked(callbacks.onError).mock.calls[0]!;
    vi.mocked(fetch).mockImplementation(async () => Response.json(credentials('recovered')));
    await vi.advanceTimersByTimeAsync(300000 - 3000);
    expect(callbacks.onIceRecovered).toHaveBeenCalledWith(code, message);
    controller.close();
  });

  it('fetches fresh credentials for late peers after a throttled timer misses expiry', async () => {
    const { controller, socket, connection } = await meeting();
    vi.setSystemTime(Date.now() + HOUR + 1);
    vi.mocked(fetch).mockImplementation(async () => Response.json(credentials('after-sleep')));
    socket.message({ type: 'peer-joined', peer: { ...peer, peerId: 'c'.repeat(32) } });
    socket.message({ type: 'peer-joined', peer: { ...peer, peerId: 'd'.repeat(32) } });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(PeerConnection.instances).toHaveLength(3);
    expect(connection.configuration.iceServers).toEqual(credentials('after-sleep').iceServers);
    expect(PeerConnection.instances[1]!.configuration.iceServers).toEqual(credentials('after-sleep').iceServers);
    expect(PeerConnection.instances[2]!.configuration.iceServers).toEqual(credentials('after-sleep').iceServers);
    controller.close();
  });

  it('never creates a peer using expired credentials when renewal fails', async () => {
    const { controller, socket, callbacks } = await meeting();
    vi.setSystemTime(Date.now() + HOUR + 1);
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    socket.message({ type: 'peer-joined', peer: { ...peer, peerId: 'c'.repeat(32) } });
    await vi.advanceTimersByTimeAsync(0);
    expect(PeerConnection.instances).toHaveLength(1);
    expect(callbacks.onError).toHaveBeenCalledWith('ICE_PROVISIONING_FAILED', expect.any(String));
    controller.close();
  });

  it('revalidates credentials before an ICE restart after expiry', async () => {
    const { controller, connection } = await meeting();
    vi.setSystemTime(Date.now() + HOUR + 1);
    vi.mocked(fetch).mockImplementation(async () => Response.json(credentials('restart')));
    connection.changeIce('failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(connection.configuration.iceServers).toEqual(credentials('restart').iceServers);
    expect(connection.restartIce).toHaveBeenCalledTimes(1);
    expect(connection.setConfiguration.mock.invocationCallOrder[0]).toBeLessThan(connection.restartIce.mock.invocationCallOrder[0]!);
    controller.close();
  });

  it('refreshes before negotiation when a sleeping tab missed credential expiry', async () => {
    const { controller, connection } = await meeting();
    vi.setSystemTime(Date.now() + HOUR + 1);
    vi.mocked(fetch).mockImplementation(async () => Response.json(credentials('negotiation')));
    connection.dispatchEvent(new Event('negotiationneeded'));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.configuration.iceServers).toEqual(credentials('negotiation').iceServers);
    expect(connection.setLocalDescription).toHaveBeenCalledTimes(1);
    expect(connection.setConfiguration.mock.invocationCallOrder[0]).toBeLessThan(connection.setLocalDescription.mock.invocationCallOrder[0]!);
    controller.close();
  });

  it('never restarts with expired credentials when provisioning remains unavailable', async () => {
    const { controller, connection, callbacks } = await meeting();
    vi.setSystemTime(Date.now() + HOUR + 1);
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    connection.changeIce('failed');
    await vi.advanceTimersByTimeAsync(60000);
    expect(connection.restartIce).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(callbacks.onError).toHaveBeenCalledWith('ICE_PROVISIONING_FAILED', expect.any(String));
    expect(callbacks.onError).toHaveBeenCalledWith('PEER_CONNECTION_FAILED', expect.any(String));
    controller.close();
  });

  it('bounds failed ICE restarts and reports exhaustion once', async () => {
    const { controller, connection, callbacks } = await meeting();
    connection.changeIce('failed');
    await vi.advanceTimersByTimeAsync(60000);
    expect(connection.restartIce).toHaveBeenCalledTimes(3);
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).toHaveBeenCalledWith('PEER_CONNECTION_FAILED', expect.stringContaining('Rejoin'));
    connection.changeIce('failed');
    await vi.advanceTimersByTimeAsync(60000);
    expect(connection.restartIce).toHaveBeenCalledTimes(3);
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    controller.close();
  });

  it('allows a disconnected grace period, cancels it on recovery, and resets the restart budget', async () => {
    const { controller, connection, callbacks } = await meeting();
    connection.changeIce('disconnected');
    await vi.advanceTimersByTimeAsync(4999);
    expect(connection.restartIce).not.toHaveBeenCalled();
    connection.changeIce('connected');
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.restartIce).not.toHaveBeenCalled();
    connection.changeIce('failed');
    await vi.advanceTimersByTimeAsync(10001);
    expect(connection.restartIce).toHaveBeenCalledTimes(2);
    connection.changeIce('connected');
    connection.changeIce('disconnected');
    await vi.advanceTimersByTimeAsync(5000);
    expect(connection.restartIce).toHaveBeenCalledTimes(3);
    expect(callbacks.onError).not.toHaveBeenCalled();
    controller.close();
  });

  it('cancels peer recovery on departure and all meeting timers on leave', async () => {
    const { controller, socket, connection } = await meeting();
    connection.changeIce('disconnected');
    socket.message({ type: 'peer-left', peerId: peer.peerId });
    await vi.advanceTimersByTimeAsync(5000);
    expect(connection.restartIce).not.toHaveBeenCalled();
    controller.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(HOUR * 2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not open signaling or emit an error after leave aborts provisioning', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal ?? undefined;
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const callbacks = events();
    const controller = new MeetingController([], callbacks);
    const rejected = expect(controller.connect(args)).rejects.toThrow('Meeting closed.');
    controller.close();
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(Socket.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
