import type { AgentCommand, AgentRoomState } from './agents/contracts';
import {
  MAX_PEER_MESSAGE_BYTES,
  parsePeerMessage,
  type ClientMessage,
  type PeerIdentity,
  type PeerMessage,
  type ServerMessage,
  type SignalKind,
} from './protocol';
import { IceConfigurationError, MeetingIceConfiguration, type IceConfiguration } from './ice-configuration';

const DATA_CHANNEL_LABEL = 'weave-in';
const MAX_ICE_RESTARTS = 3;
const ICE_RESTART_WAIT_MS = 10000;
const ICE_DISCONNECTED_GRACE_MS = 5000;

export interface MeetingControllerEvents {
  onAgentState?(state: AgentRoomState, serverNow: number): void;
  onReconnecting?(): void;
  onConnected(self: PeerIdentity, peers: PeerIdentity[], startedAt: number): void;
  onPeerJoined(peer: PeerIdentity): void;
  onPeerLeft(peerId: string): void;
  onRemoteStream(peerId: string, stream: MediaStream): void;
  onRemoteStreamEnded(peerId: string, streamId: string): void;
  onPeerChannelOpen(peerId: string): void;
  onPeerMessage(peerId: string, message: PeerMessage): void;
  /** A peer opened an additional data channel (for example a file transfer); the label says what it carries. */
  onPeerChannel(peerId: string, channel: RTCDataChannel): void;
  onError(code: string, message: string): void;
  onIceRecovered?(code: string, message: string): void;
}

interface PeerConnectionState {
  connection: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingIce: RTCIceCandidateInit[];
  channel: RTCDataChannel | null;
  senders: Map<string, RTCRtpSender>;
  streams: Map<string, MediaStream>;
  restartTimer: ReturnType<typeof setTimeout> | undefined;
  restarting: boolean;
  restartAttempts: number;
  recoveryFailed: boolean;
  restartRequested: boolean;
  generation: number;
}

/**
 * Full-mesh WebRTC meeting: one RTCPeerConnection per remote participant, negotiated
 * with the "perfect negotiation" pattern so tracks (camera, screen share) can be added
 * or removed at any time. Chat and transcript messages travel over a per-peer data
 * channel; the signaling server only relays SDP and ICE.
 */
export class MeetingController {
  readonly #events: MeetingControllerEvents;
  readonly #connections = new Map<string, PeerConnectionState>();
  readonly #localStreams = new Map<string, MediaStream>();
  readonly #ice: MeetingIceConfiguration;
  #socket: WebSocket | null = null;
  #self: PeerIdentity | null = null;
  #closing = false;
  #connecting = false;
  #generation = 0;
  #lastIceError: IceConfigurationError | null = null;
  sessionToken = '';
  sendAgent(command: AgentCommand): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(command));
  }
  #args: { roomCode: string; action: 'create' | 'join'; displayName: string; peerId: string } | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryDelay = 1000;
  #retrying = false;
  #scheduleReconnect(): void {
    if (this.#closing || this.#retryTimer || !this.#args) return;
    this.#retrying = true;
    this.#events.onReconnecting?.();
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (this.#closing || !this.#args) return;
      this.#socket = null;
      void this.connect({ ...this.#args, action: 'join' }).catch(() => {
        this.#retryDelay = Math.min(this.#retryDelay * 2, 10000);
        this.#scheduleReconnect();
      });
    }, this.#retryDelay);
  }

  constructor(localStreams: MediaStream[], events: MeetingControllerEvents) {
    for (const stream of localStreams) this.#localStreams.set(stream.id, stream);
    this.#events = events;
    this.#ice = new MeetingIceConfiguration(
      (configuration) => this.#updateIceConfiguration(configuration),
      (error) => this.#reportIceError(error),
    );
  }

  async connect(args: {
    roomCode: string;
    action: 'create' | 'join';
    displayName: string;
    peerId: string;
  }): Promise<void> {
    if (this.#closing) throw new Error('Meeting closed.');
    if (this.#socket || this.#connecting) throw new Error('MeetingController is already connected.');
    this.#args = args;
    this.#connecting = true;
    try {
      await this.#ice.get();
    } catch (error) {
      this.#reportIceError(error);
      throw error;
    } finally {
      this.#connecting = false;
    }
    if (this.#closing) throw new Error('Meeting closed.');
    const endpoint = new URL(`/api/rooms/${args.roomCode}/connect`, window.location.href);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    endpoint.searchParams.set('action', args.action);
    endpoint.searchParams.set('name', args.displayName);
    endpoint.searchParams.set('peerId', args.peerId);

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      this.#socket = socket;
      let welcomed = false;
      let messages = Promise.resolve();
      const timeout = setTimeout(() => {
        if (welcomed || this.#closing) return;
        reject(new Error('Signaling connection timed out.'));
        socket.close();
      }, 10000);
      socket.addEventListener('message', (event) => {
        if (this.#closing || this.#socket !== socket) return;
        messages = messages.then(async () => {
          if (this.#closing || this.#socket !== socket) return;
          const didWelcome = await this.#receive(event.data);
          if (this.#closing || this.#socket !== socket) return;
          if (!welcomed && didWelcome) {
            welcomed = true;
            clearTimeout(timeout);
            this.#retrying = false;
            this.#retryDelay = 1000;
            resolve();
          }
        }).catch((error: unknown) => {
          if (this.#closing || this.#socket !== socket) return;
          this.#reportIceError(error);
          if (!welcomed) {
            reject(error);
            socket.close();
          }
        });
      });
      socket.addEventListener('error', () => {
        if (!welcomed) reject(new Error('The signaling connection could not be established.'));
        if (!this.#self && !this.#retrying) this.#events.onError('SIGNALING_ERROR', 'The signaling connection encountered an error.');
      });
      socket.addEventListener('close', () => {
        clearTimeout(timeout);
        if (!welcomed) reject(new Error('The room is unavailable, full, or no longer active.'));
        if (this.#socket !== socket || this.#closing) return;
        this.#generation += 1;
        this.#socket = null;
        if (welcomed) this.#scheduleReconnect();
      });
    });
  }

  close(): void {
    if (this.#closing) return;
    this.#closing = true;
    this.#generation += 1;
    clearTimeout(this.#retryTimer);
    this.#ice.close();
    for (const state of this.#connections.values()) {
      this.#closePeer(state);
    }
    this.#connections.clear();
    this.#socket?.close(1000, 'Left meeting');
    this.#socket = null;
    this.sessionToken = '';
  }

  /** Shares an additional local stream (for example a screen capture) with every peer. */
  addStream(stream: MediaStream): void {
    if (this.#localStreams.has(stream.id)) return;
    this.#localStreams.set(stream.id, stream);
    for (const state of this.#connections.values()) this.#attachStream(state, stream);
  }

  removeStream(streamId: string): void {
    const stream = this.#localStreams.get(streamId);
    if (!stream) return;
    this.#localStreams.delete(streamId);
    for (const state of this.#connections.values()) {
      for (const track of stream.getTracks()) {
        const sender = state.senders.get(track.id);
        if (!sender) continue;
        state.senders.delete(track.id);
        try {
          state.connection.removeTrack(sender);
        } catch {
          // The connection is already closed.
        }
      }
    }
  }

  broadcast(message: PeerMessage): void {
    const encoded = JSON.stringify(message);
    for (const state of this.#connections.values()) {
      if (state.channel?.readyState === 'open') state.channel.send(encoded);
    }
  }

  send(peerId: string, message: PeerMessage): boolean {
    const channel = this.#connections.get(peerId)?.channel;
    if (channel?.readyState !== 'open') return false;
    channel.send(JSON.stringify(message));
    return true;
  }

  /**
   * Opens an extra data channel to one peer. The SCTP transport already exists once the
   * meeting channel is up, so this needs no renegotiation; the peer receives it through
   * `onPeerChannel`.
   */
  openChannel(peerId: string, label: string): RTCDataChannel | null {
    const state = this.#connections.get(peerId);
    if (!state || state.connection.connectionState === 'closed') return null;
    try {
      return state.connection.createDataChannel(label);
    } catch {
      return null;
    }
  }

  async #receive(raw: unknown): Promise<boolean> {
    if (typeof raw !== 'string') return false;
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      this.#events.onError('INVALID_SERVER_MESSAGE', 'The signaling server returned invalid data.');
      return false;
    }

    switch (message.type) {
      case 'agent-state':
        this.#events.onAgentState?.(message.state, message.serverNow);
        return false;
      case 'welcome':
        this.sessionToken = message.sessionToken;
        this.#generation += 1;
        for (const state of this.#connections.values()) this.#closePeer(state);
        this.#connections.clear();
        this.#self = message.self;
        // Translate the server's elapsed duration onto this device's clock.
        const localStartedAt = Date.now() - Math.max(0, message.serverTime - message.startedAt);
        this.#events.onConnected(message.self, message.peers, localStartedAt);
        for (const peer of message.peers) await this.#ensurePeer(peer.peerId);
        return true;
      case 'peer-joined':
        this.#events.onPeerJoined(message.peer);
        await this.#ensurePeer(message.peer.peerId);
        return false;
      case 'peer-left':
        this.#dropPeer(message.peerId);
        return false;
      case 'signal':
        await this.#handleSignal(message.from, message.kind, message.payload);
        return false;
      case 'error':
        if (this.#retrying) return false;
        this.#events.onError(message.code, message.message);
        return false;
    }
  }

  async #ensurePeer(peerId: string): Promise<PeerConnectionState> {
    const generation = this.#generation;
    const configuration = await this.#ice.get();
    if (this.#closing || this.#generation !== generation) throw new Error('Meeting connection changed.');
    const existing = this.#connections.get(peerId);
    if (existing) return existing;
    const connection = new RTCPeerConnection({ iceServers: configuration.iceServers });
    const state: PeerConnectionState = {
      connection,
      polite: !this.#isImpolite(peerId),
      makingOffer: false,
      ignoreOffer: false,
      pendingIce: [],
      channel: null,
      senders: new Map(),
      streams: new Map(),
      restartTimer: undefined,
      restarting: false,
      restartAttempts: 0,
      recoveryFailed: false,
      restartRequested: false,
      generation: this.#generation,
    };
    this.#connections.set(peerId, state);

    if (!state.polite) this.#attachChannel(peerId, state, connection.createDataChannel(DATA_CHANNEL_LABEL));
    connection.addEventListener('datachannel', (event) => {
      if (event.channel.label === DATA_CHANNEL_LABEL) this.#attachChannel(peerId, state, event.channel);
      else this.#events.onPeerChannel(peerId, event.channel);
    });
    connection.addEventListener('negotiationneeded', () => void this.#negotiate(peerId, state));
    connection.addEventListener('icecandidate', (event) => {
      if (event.candidate && this.#isCurrentPeer(peerId, state)) this.#sendSignal(peerId, 'ice', event.candidate.toJSON());
    });
    connection.addEventListener('track', (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      if (!state.streams.has(stream.id)) {
        state.streams.set(stream.id, stream);
        stream.addEventListener('removetrack', () => {
          if (stream.getTracks().length !== 0) return;
          state.streams.delete(stream.id);
          this.#events.onRemoteStreamEnded(peerId, stream.id);
        });
      }
      this.#events.onRemoteStream(peerId, stream);
    });
    connection.addEventListener('iceconnectionstatechange', () => this.#iceStateChanged(peerId, state));
    connection.addEventListener('connectionstatechange', () => this.#iceStateChanged(peerId, state));
    for (const stream of this.#localStreams.values()) this.#attachStream(state, stream);
    return state;
  }

  #attachStream(state: PeerConnectionState, stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      if (state.senders.has(track.id)) continue;
      state.senders.set(track.id, state.connection.addTrack(track, stream));
    }
  }

  #attachChannel(peerId: string, state: PeerConnectionState, channel: RTCDataChannel): void {
    state.channel = channel;
    let announced = false;
    const announce = (): void => {
      if (announced || state.channel !== channel) return;
      announced = true;
      this.#events.onPeerChannelOpen(peerId);
    };
    channel.addEventListener('open', announce);
    // A channel handed over by the `datachannel` event can already be open, and then no `open` event follows.
    if (channel.readyState === 'open') queueMicrotask(announce);
    channel.addEventListener('message', (event) => {
      if (typeof event.data !== 'string' || event.data.length > MAX_PEER_MESSAGE_BYTES) return;
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      const message = parsePeerMessage(raw);
      if (message) this.#events.onPeerMessage(peerId, message);
    });
  }

  async #negotiate(peerId: string, state: PeerConnectionState): Promise<void> {
    // The polite peer never opens the first negotiation: its transceivers are associated with the
    // impolite peer's initial offer and answered in one round. Offering as well would only cause glare,
    // and rolling back a first offer leaves some browsers without ICE candidates for the replacement.
    if (state.polite && !state.connection.remoteDescription) return;
    try {
      state.makingOffer = true;
      await this.#ice.get();
      if (!this.#isCurrentPeer(peerId, state)) return;
      await state.connection.setLocalDescription();
      // If a remote offer was applied while this was queued, the implicit description is an answer, not an offer.
      this.#sendLocalDescription(peerId, state);
    } catch (error) {
      if (!this.#isCurrentPeer(peerId, state)) return;
      if (error instanceof IceConfigurationError) this.#reportIceError(error);
      else this.#events.onError('NEGOTIATION_FAILED', 'Could not negotiate a participant media connection.');
    } finally {
      state.makingOffer = false;
    }
  }

  async #handleSignal(
    peerId: string,
    kind: SignalKind,
    payload: RTCSessionDescriptionInit | RTCIceCandidateInit,
  ): Promise<void> {
    const state = await this.#ensurePeer(peerId);
    const { connection } = state;
    try {
      if (kind === 'offer' || kind === 'answer') {
        const description = payload as RTCSessionDescriptionInit;
        if (kind === 'offer') {
          const collision = state.makingOffer || connection.signalingState !== 'stable';
          state.ignoreOffer = !state.polite && collision;
          if (state.ignoreOffer) return;
        }
        await connection.setRemoteDescription(description);
        await this.#flushIce(state);
        // Answer only if nothing else (a concurrent `negotiationneeded`) already did.
        if (kind === 'offer' && connection.signalingState === 'have-remote-offer') {
          await this.#ice.get();
          if (!this.#isCurrentPeer(peerId, state)) return;
          await connection.setLocalDescription();
          this.#sendLocalDescription(peerId, state);
        }
        return;
      }
      const candidate = payload as RTCIceCandidateInit;
      if (!connection.remoteDescription) {
        state.pendingIce.push(candidate);
        return;
      }
      try {
        await connection.addIceCandidate(candidate);
      } catch (error) {
        if (!state.ignoreOffer) throw error;
      }
    } catch (error) {
      if (!this.#isCurrentPeer(peerId, state)) return;
      if (error instanceof IceConfigurationError) this.#reportIceError(error);
      else this.#events.onError('INVALID_NEGOTIATION', 'A peer sent an unusable WebRTC negotiation message.');
    }
  }

  #sendLocalDescription(peerId: string, state: PeerConnectionState): void {
    if (!this.#isCurrentPeer(peerId, state)) return;
    const description = state.connection.localDescription;
    if (!description?.sdp) return;
    if (description.type !== 'offer' && description.type !== 'answer') return;
    this.#sendSignal(peerId, description.type, { type: description.type, sdp: description.sdp });
  }

  async #flushIce(state: PeerConnectionState): Promise<void> {
    for (const candidate of state.pendingIce.splice(0)) {
      await state.connection.addIceCandidate(candidate);
    }
  }

  #sendSignal(
    target: string,
    kind: SignalKind,
    payload: RTCSessionDescriptionInit | RTCIceCandidateInit,
  ): void {
    const message: ClientMessage = { type: 'signal', target, kind, payload };
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  #dropPeer(peerId: string): void {
    const state = this.#connections.get(peerId);
    if (state) this.#closePeer(state);
    this.#connections.delete(peerId);
    this.#events.onPeerLeft(peerId);
  }

  #closePeer(state: PeerConnectionState): void {
    clearTimeout(state.restartTimer);
    state.channel?.close();
    state.connection.close();
  }

  #isCurrentPeer(peerId: string, state: PeerConnectionState): boolean {
    return !this.#closing && state.generation === this.#generation && this.#connections.get(peerId) === state && state.connection.connectionState !== 'closed';
  }

  #reportIceError(error: unknown): void {
    if (this.#closing || !(error instanceof IceConfigurationError) || this.#lastIceError?.code === error.code) return;
    this.#lastIceError = error;
    this.#events.onError(error.code, error.message);
  }

  #updateIceConfiguration(configuration: IceConfiguration): void {
    const previousError = this.#lastIceError;
    this.#lastIceError = null;
    for (const [peerId, state] of this.#connections) {
      if (state.connection.connectionState === 'closed') continue;
      state.connection.setConfiguration({ ...state.connection.getConfiguration(), iceServers: configuration.iceServers });
      // A new ICE gathering phase replaces allocations authenticated with the old credentials.
      state.restartRequested = true;
      if (state.recoveryFailed) state.restartAttempts = 0;
      state.recoveryFailed = false;
      this.#scheduleIceRestart(peerId, state, 0);
    }
    if (previousError) this.#events.onIceRecovered?.(previousError.code, previousError.message);
  }

  #iceStateChanged(peerId: string, state: PeerConnectionState): void {
    if (!this.#isCurrentPeer(peerId, state)) return;
    const { connection } = state;
    if (connection.iceConnectionState === 'connected' || connection.iceConnectionState === 'completed') {
      if (state.restartRequested) {
        this.#scheduleIceRestart(peerId, state, 0);
        return;
      }
      clearTimeout(state.restartTimer);
      state.restartTimer = undefined;
      state.restartAttempts = 0;
      state.recoveryFailed = false;
      return;
    }
    const failed = connection.iceConnectionState === 'failed' || connection.connectionState === 'failed';
    if (failed || connection.iceConnectionState === 'disconnected') {
      this.#scheduleIceRestart(peerId, state, failed ? 0 : ICE_DISCONNECTED_GRACE_MS);
    }
  }

  #scheduleIceRestart(peerId: string, state: PeerConnectionState, delay: number): void {
    if (!this.#isCurrentPeer(peerId, state) || state.restartTimer !== undefined || state.restarting || state.recoveryFailed) return;
    state.restartTimer = setTimeout(() => {
      state.restartTimer = undefined;
      void this.#restartIce(peerId, state);
    }, delay);
  }

  async #restartIce(peerId: string, state: PeerConnectionState): Promise<void> {
    if (!this.#isCurrentPeer(peerId, state)) return;
    if (state.restartAttempts >= MAX_ICE_RESTARTS) {
      state.recoveryFailed = true;
      this.#events.onError('PEER_CONNECTION_FAILED', 'A participant connection could not recover. Rejoin the room to retry.');
      return;
    }
    state.restarting = true;
    state.restartAttempts += 1;
    try {
      await this.#ice.get();
      if (!this.#isCurrentPeer(peerId, state)) return;
      if (!state.restartRequested && (state.connection.iceConnectionState === 'connected' || state.connection.iceConnectionState === 'completed')) return;
      state.restartRequested = false;
      state.connection.restartIce();
    } catch (error) {
      this.#reportIceError(error);
    } finally {
      state.restarting = false;
      if (state.connection.iceConnectionState !== 'connected' && state.connection.iceConnectionState !== 'completed') {
        this.#scheduleIceRestart(peerId, state, ICE_RESTART_WAIT_MS);
      }
    }
  }

  /** The peer with the lexically smaller id is impolite: it creates the data channel and wins offer collisions. */
  #isImpolite(peerId: string): boolean {
    return Boolean(this.#self && this.#self.peerId.localeCompare(peerId) < 0);
  }
}

export function createPeerId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

export function createRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}
