import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectWithIdentityRecovery, MeetingController, RoomAdmissionError, type MeetingControllerEvents } from '../src/meeting-controller';
import { emptyAgentRoom } from '../src/agents/contracts';
class Socket extends EventTarget {
  static instances: Socket[] = [];
  static OPEN = 1;
  readyState = 1;
  constructor(readonly url: string) {
    super();
    Socket.instances.push(this);
  }
  send = vi.fn();
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  message(message: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  welcome(peers: { peerId: string; name: string; isHost: boolean }[] = [], sessionToken = 'initial-token') {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'welcome',
          sessionToken,
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
    onConnected: vi.fn(), onReconnecting: vi.fn(), onError: vi.fn(), onIceRecovered: vi.fn(), onAgentState: vi.fn(),
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Socket.instances = [];
  PeerConnection.instances = [];
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
    await vi.advanceTimersByTimeAsync(0);
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
    expect(vi.getTimerCount()).toBe(0);
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
    await vi.advanceTimersByTimeAsync(0);
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
    const retry = controller.connect(args);
    await vi.advanceTimersByTimeAsync(0);
    Socket.instances[1]!.welcome();
    await retry;
    expect(events.onConnected).toHaveBeenCalledTimes(1);
    controller.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['error', 'close', 'timeout'])('cleans up a failed initial connection after %s', async (failure) => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { location: { href: 'https://meeting.test' } });
    vi.stubGlobal('WebSocket', Socket);
    const events = { onConnected: vi.fn(), onReconnecting: vi.fn(), onError: vi.fn() } as unknown as MeetingControllerEvents;
    const controller = new MeetingController([], events);
    const ready = controller.connect({ roomCode: 'ABCDEF', action: 'join', displayName: 'Alice', peerId: 'a'.repeat(32) });
    const rejected = expect(ready).rejects.toThrow(failure === 'timeout' ? 'timed out' : failure === 'close' ? 'connection closed' : 'Unable to connect');
    await vi.advanceTimersByTimeAsync(0);
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(10000);
    else Socket.instances[0]!.dispatchEvent(new Event(failure));
    await rejected;
    expect(Socket.instances[0]!.readyState).toBe(3);
    expect(events.onReconnecting).not.toHaveBeenCalled();
    controller.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports errors after admission without disconnecting the room', async () => {
    vi.stubGlobal('window', { location: { href: 'https://meeting.test' } });
    vi.stubGlobal('WebSocket', Socket);
    const events = { onConnected: vi.fn(), onError: vi.fn() } as unknown as MeetingControllerEvents;
    const controller = new MeetingController([], events);
    const ready = controller.connect({ roomCode: 'ABCDEF', action: 'join', displayName: 'Alice', peerId: 'a'.repeat(32) });
    await vi.advanceTimersByTimeAsync(0);
    Socket.instances[0]!.welcome();
    await ready;
    Socket.instances[0]!.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'error', code: 'PEER_NOT_FOUND', message: 'The peer left.' }),
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onError).toHaveBeenCalledWith('PEER_NOT_FOUND', 'The peer left.');
    expect(Socket.instances[0]!.readyState).toBe(1);
    controller.close();
    expect(vi.getTimerCount()).toBe(0);
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
    await vi.advanceTimersByTimeAsync(0);
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
    Socket.instances[3]!.welcome([], 'reconnected-token');
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
    expect(vi.getTimerCount()).toBe(0);
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

  it('keeps agent commands and room-state updates working alongside relay provisioning', async () => {
    const callbacks = events();
    const controller = new MeetingController([], callbacks);
    vi.mocked(callbacks.onConnected).mockImplementation(() => {
      expect(controller.sessionToken).toBe('agent-session-token');
      controller.sendAgent({ type: 'agent-ready', ready: true, groupReady: true });
    });
    const ready = controller.connect(args);
    await vi.advanceTimersByTimeAsync(0);
    const socket = Socket.instances[0]!;
    socket.welcome([peer], 'agent-session-token');
    const state = emptyAgentRoom();
    socket.message({ type: 'agent-state', state, serverNow: Date.now() });
    await ready;
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'agent-ready', ready: true, groupReady: true }));
    expect(callbacks.onAgentState).toHaveBeenCalledWith(state, Date.now());
    expect(PeerConnection.instances[0]!.configuration.iceServers).toEqual(credentials().iceServers);
    expect(fetch).toHaveBeenCalledTimes(1);
    controller.close();
    controller.sendAgent({ type: 'agent-heartbeat' });
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(controller.sessionToken).toBe('');
  });

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
    expect(vi.getTimerCount()).toBe(0);
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
    expect(vi.getTimerCount()).toBe(0);
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
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarts healthy ICE connections after renewed credentials replace their configuration', async () => {
    const { controller, connection } = await meeting();
    connection.changeIce('connected');
    vi.mocked(fetch).mockImplementation(async () => Response.json(credentials('renewed')));
    await vi.advanceTimersByTimeAsync(HOUR - 300000 + 1);
    expect(connection.restartIce).toHaveBeenCalledTimes(1);
    expect(connection.setConfiguration.mock.invocationCallOrder[0]).toBeLessThan(connection.restartIce.mock.invocationCallOrder[0]!);
    controller.close();
    expect(vi.getTimerCount()).toBe(0);
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
    expect(vi.getTimerCount()).toBe(0);
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
    expect(vi.getTimerCount()).toBe(0);
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
    expect(vi.getTimerCount()).toBe(0);
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
    expect(vi.getTimerCount()).toBe(0);
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
    expect(vi.getTimerCount()).toBe(0);
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
    expect(vi.getTimerCount()).toBe(0);
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
    expect(vi.getTimerCount()).toBe(0);
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
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels peer recovery on departure and all meeting timers on leave', async () => {
    const { controller, socket, connection } = await meeting();
    connection.changeIce('disconnected');
    socket.message({ type: 'peer-left', peerId: peer.peerId });
    await vi.advanceTimersByTimeAsync(5000);
    expect(connection.restartIce).not.toHaveBeenCalled();
    controller.close();
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
  });
});
