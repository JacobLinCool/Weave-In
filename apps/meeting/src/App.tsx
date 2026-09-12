import { PrivateNotices } from './private-notices';
import { PrivateNoticeDock } from './private-notice-ui';
import {
  createTranscription,
  type Credential,
  type Transcription,
  type TranscriptState,
  type TranscriptionProvider,
} from '@weave-in/transcribe';
import { LoaderCircle, LockKeyhole } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { threadColor, threadStyle } from './brand';
import {
  ErrorNotice,
  MeetingControls,
  RoomHeader,
  SettingsDialog,
  SidePanel,
  VideoTile,
  type CaptionState,
  type ChatMessage,
  type LiveInterim,
  type SidePanelTab,
  type TranscriptLine,
  type TranscriptionView,
} from './components';
import { FileShare, type SharedFile } from './file-share';
import { batchHistory, insertByTime, selectHistory } from './history';
import { LandingSurface } from './landing';
import { createPeerId, createRoomCode, MeetingController } from './meeting-controller';
import { MeetingLog, type LogParticipant } from './meeting-log';
import {
  MAX_FILE_BYTES,
  normalizeDisplayName,
  ROOM_CODE_PATTERN,
  type HistoryEntry,
  type PeerIdentity,
  type PeerMediaState,
  type PeerMessage,
} from './protocol';
import {
  readSettings,
  transcriptionOverrides,
  transcriptionSettingsChanged,
  writeSettings,
  type MeetingSettings,
} from './settings';
import { captureVideoFrame } from './screen-capture';
import { registerMeetingTools, type MeetingSnapshot, type ScreenCapture } from './webmcp';

type AppPhase = 'lobby' | 'connecting' | 'room' | 'leaving';

interface RemoteParticipant {
  identity: PeerIdentity;
  seat: number;
  streams: Record<string, MediaStream>;
  media: PeerMediaState | null;
}

interface Presentation {
  name: string;
  stream: MediaStream;
  local: boolean;
}

interface IssuedToken {
  provider: TranscriptionProvider;
  token: string;
}

const SELF = 'self';
const DISPLAY_NAME_STORAGE_KEY = 'weave-in:display-name';
const ROOM_QUERY_PARAM = 'room';
const IDLE_TRANSCRIPTION: TranscriptionView = { status: 'idle', error: null };

export function App(): ReactNode {
  const [privateNotices] = useState(() => new PrivateNotices());
  const [phase, setPhase] = useState<AppPhase>('lobby');
  const [displayName, setDisplayName] = useState(readStoredDisplayName);
  const [roomInput, setRoomInput] = useState(readRoomCodeFromUrl);
  const [invitedRoom] = useState(readRoomCodeFromUrl);
  const [roomCode, setRoomCode] = useState('');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [participants, setParticipants] = useState<Record<string, RemoteParticipant>>({});
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [files, setFiles] = useState<Record<string, SharedFile>>({});
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [interims, setInterims] = useState<Record<string, LiveInterim>>({});
  const [captions, setCaptions] = useState<Record<string, CaptionState>>({});
  const [transcription, setTranscription] = useState<TranscriptionView>(IDLE_TRANSCRIPTION);
  const [panelTab, setPanelTab] = useState<SidePanelTab>('chat');
  const [settings, setSettings] = useState<MeetingSettings>(() => readSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [joinedAt, setJoinedAt] = useState<string | null>(null);
  const [roomStartedAt, setRoomStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const transcriptionRef = useRef<Transcription | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const controllerRef = useRef<MeetingController | null>(null);
  const participantsRef = useRef<Record<string, RemoteParticipant>>({});
  const nameRef = useRef('You');
  const micRef = useRef(true);
  const cameraRef = useRef(true);
  const sessionIdRef = useRef<string | null>(null);
  const cursorRef = useRef(0);
  const interimRef = useRef('');
  const phaseRef = useRef<AppPhase>('lobby');
  const settingsRef = useRef<MeetingSettings>(settings);
  const settingsAtOpenRef = useRef<MeetingSettings | null>(null);
  const restartGenerationRef = useRef(0);
  const seatsRef = useRef(new Map<string, number>());
  const nextSeatRef = useRef(1);
  const fileShareRef = useRef<FileShare | null>(null);
  const logRef = useRef(new MeetingLog());
  const selfRef = useRef<PeerIdentity | null>(null);
  const roomCodeRef = useRef('');
  const filesRef = useRef<Record<string, SharedFile>>({});
  const interimsRef = useRef<Record<string, LiveInterim>>({});
  const transcriptionRef2 = useRef<TranscriptionView>(IDLE_TRANSCRIPTION);
  const messagesRef = useRef<ChatMessage[]>([]);
  const transcriptRef = useRef<TranscriptLine[]>([]);
  /** Peers that joined after this participant: they receive this participant's history when their channel opens. */
  const newcomersRef = useRef(new Set<string>());
  /** Peers that were here first and have not finished replaying their history yet. */
  const syncingRef = useRef(new Set<string>());
  /** `peerId:id` of every remote chat message and caption seen, so replays never duplicate live traffic. */
  const seenRef = useRef(new Set<string>());
  phaseRef.current = phase;
  filesRef.current = files;
  interimsRef.current = interims;
  transcriptionRef2.current = transcription;
  messagesRef.current = messages;
  transcriptRef.current = transcript;

  /** Seat 0 is always you; peers take the next dyed thread in join order. */
  const seatFor = (peerId: string): number => {
    const existing = seatsRef.current.get(peerId);
    if (existing !== undefined) return existing;
    const seat = nextSeatRef.current++;
    seatsRef.current.set(peerId, seat);
    return seat;
  };
  const colorFor = (peerId: string): string => threadColor(peerId === SELF ? 0 : seatFor(peerId)).hex;

  const peerName = (peerId: string): string => participantsRef.current[peerId]?.identity.name ?? 'Guest';

  /** Who a peer id stands for in the meeting record; `'self'` resolves to this participant's real identity. */
  const logParticipant = (peerId: string): LogParticipant => {
    if (peerId === SELF) return { peerId: selfRef.current?.peerId ?? SELF, name: nameRef.current };
    return { peerId, name: peerName(peerId) };
  };

  /** Records a remote entry key; returns false when it was already seen (a replay of something live, or a repeat). */
  const markSeen = (peerId: string, id: string): boolean => {
    const key = `${peerId}:${id}`;
    if (seenRef.current.has(key)) return false;
    seenRef.current.add(key);
    return true;
  };

  /** Sends this participant's own past chat and captions to a peer that joined later, oldest first, in bounded batches. */
  const replayHistoryTo = (peerId: string): void => {
    const controller = controllerRef.current;
    if (!controller) return;
    const entries: HistoryEntry[] = [
      ...messagesRef.current.flatMap((message): HistoryEntry[] =>
        message.own && message.kind === 'text' ? [{ kind: 'chat', id: message.id, text: message.text, at: message.at, agent: message.agent }] : []),
      ...transcriptRef.current.flatMap((line): HistoryEntry[] =>
        line.own && line.text ? [{ kind: 'transcript', id: line.id, text: line.text, at: line.at }] : []),
    ];
    for (const batch of batchHistory(selectHistory(entries))) controller.send(peerId, batch);
  };

  const setCaption = (speaker: string, caption: CaptionState | null): void => {
    setCaptions((current) => {
      if (!caption) return omitKey(current, speaker);
      return { ...current, [speaker]: caption };
    });
  };

  const currentMediaState = (): PeerMediaState => ({
    cameraStreamId: localStreamRef.current?.id ?? null,
    screenStreamId: screenStreamRef.current?.id ?? null,
    micOn: micRef.current,
    cameraOn: cameraRef.current,
  });

  const broadcastMediaState = (): void => {
    controllerRef.current?.broadcast({ type: 'state', ...currentMediaState() });
  };

  const handleTranscriptionState = useCallback((state: TranscriptState): void => {
    setTranscription({
      status: state.status,
      error: state.error ? { code: state.error.code, message: state.error.message } : null,
    });
    if (state.sessionId !== sessionIdRef.current) {
      sessionIdRef.current = state.sessionId;
      cursorRef.current = 0;
    }
    const sessionKey = state.sessionId ?? 'session';
    const fresh = state.segments.filter((segment) => segment.id > cursorRef.current);
    const last = fresh[fresh.length - 1];
    if (last) {
      cursorRef.current = last.id;
      const lines = fresh.map((segment) => ({
        id: `${sessionKey}-${segment.id}`,
        from: SELF,
        name: nameRef.current,
        color: colorFor(SELF),
        text: segment.text,
        at: segment.receivedAt,
        own: true,
      }));
      setTranscript((current) => [...current, ...lines]);
      for (const line of lines) {
        controllerRef.current?.broadcast({ type: 'transcript', id: line.id, text: line.text, at: line.at, final: true });
        logRef.current.append({ kind: 'transcript', at: line.at, speaker: logParticipant(SELF), text: line.text });
      }
      const latest = lines[lines.length - 1];
      if (latest) setCaptions((current) => ({ ...current, [SELF]: { text: clipCaption(latest.text), final: true, at: Date.now() } }));
    }
    const interim = clipCaption(state.interim);
    if (interim !== interimRef.current) {
      interimRef.current = interim;
      setInterims((current) => interim
        ? { ...current, [SELF]: { name: nameRef.current, color: colorFor(SELF), text: interim } }
        : omitKey(current, SELF));
      if (interim) setCaptions((current) => ({ ...current, [SELF]: { text: interim, final: false, at: Date.now() } }));
      controllerRef.current?.broadcast({
        type: 'transcript',
        id: `${sessionKey}-interim`,
        text: interim,
        at: new Date().toISOString(),
        final: false,
      });
    }
  }, []);

  const handlePeerMessage = (peerId: string, message: PeerMessage): void => {
    switch (message.type) {
      case 'state':
        setParticipants((current) => {
          const participant = current[peerId];
          if (!participant) return current;
          const next = { ...current, [peerId]: { ...participant, media: message } };
          participantsRef.current = next;
          return next;
        });
        return;
      case 'chat': {
        if (!markSeen(peerId, message.id)) return;
        setMessages((current) => [
          ...current,
          { kind: 'text', id: message.id, from: peerId, name: peerName(peerId), color: colorFor(peerId), text: message.text, at: message.at, own: false, agent: message.agent },
        ]);
        logRef.current.append({ kind: 'chat', at: message.at, sender: logParticipant(peerId), text: message.text, agent: message.agent });
        return;
      }
      case 'file': {
        const shared = fileShareRef.current?.handleMessage(peerId, message);
        if (!shared) return;
        const entry: ChatMessage = { kind: 'file', id: shared.id, from: peerId, name: peerName(peerId), color: colorFor(peerId), at: shared.at, own: false, fileId: shared.id };
        // Announcements that arrive while a peer is still replaying its past belong in the timeline, not at the end.
        const replayed = syncingRef.current.has(peerId);
        setMessages((current) => replayed ? insertByTime(current, entry) : [...current, entry]);
        logRef.current.append({
          kind: 'file',
          at: shared.at,
          sender: logParticipant(peerId),
          file: { id: shared.id, name: shared.name, size: shared.size, mime: shared.mime },
        });
        return;
      }
      case 'file-request':
      case 'file-unavailable':
        fileShareRef.current?.handleMessage(peerId, message);
        return;
      case 'history': {
        const name = peerName(peerId);
        const color = colorFor(peerId);
        const chats: ChatMessage[] = [];
        const lines: TranscriptLine[] = [];
        for (const entry of message.entries) {
          if (!markSeen(peerId, entry.id)) continue;
          if (entry.kind === 'chat') {
            chats.push({ kind: 'text', id: entry.id, from: peerId, name, color, text: entry.text, at: entry.at, own: false, agent: entry.agent });
            logRef.current.append({ kind: 'chat', at: entry.at, sender: { peerId, name }, text: entry.text, agent: entry.agent, replayed: true });
          } else {
            lines.push({ id: entry.id, from: peerId, name, color, text: entry.text, at: entry.at, own: false });
            logRef.current.append({ kind: 'transcript', at: entry.at, speaker: { peerId, name }, text: entry.text, replayed: true });
          }
        }
        if (chats.length) setMessages((current) => chats.reduce<ChatMessage[]>(insertByTime, current));
        if (lines.length) setTranscript((current) => lines.reduce<TranscriptLine[]>(insertByTime, current));
        if (!message.more) syncingRef.current.delete(peerId);
        return;
      }
      case 'transcript': {
        const name = peerName(peerId);
        const color = colorFor(peerId);
        const text = clipCaption(message.text);
        if (message.final) {
          if (!markSeen(peerId, message.id)) return;
          setTranscript((current) => [
            ...current,
            { id: message.id, from: peerId, name, color, text: message.text, at: message.at, own: false },
          ]);
          setInterims((current) => omitKey(current, peerId));
          setCaption(peerId, { text, final: true, at: Date.now() });
          if (message.text) logRef.current.append({ kind: 'transcript', at: message.at, speaker: { peerId, name }, text: message.text });
          return;
        }
        setInterims((current) => text ? { ...current, [peerId]: { name, color, text } } : omitKey(current, peerId));
        if (text) setCaption(peerId, { text, final: false, at: Date.now() });
        return;
      }
    }
  };

  const stopScreenShare = useCallback((): void => {
    const stream = screenStreamRef.current;
    if (!stream) return;
    screenStreamRef.current = null;
    controllerRef.current?.removeStream(stream.id);
    for (const track of stream.getTracks()) track.stop();
    setScreenStream(null);
    controllerRef.current?.broadcast({ type: 'state', ...currentMediaState() });
  }, []);

  const releaseLocalMedia = (): void => {
    stopScreenShare();
    for (const track of localStreamRef.current?.getTracks() ?? []) track.stop();
    localStreamRef.current = null;
    setLocalStream(null);
  };

  const stopTranscription = async (): Promise<void> => {
    const transcription = transcriptionRef.current;
    transcriptionRef.current = null;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    if (transcription) {
      await transcription.stop();
      await transcription.destroy();
    }
  };

  useEffect(() => {
    return () => {
      const transcription = transcriptionRef.current;
      const controller = controllerRef.current;
      const finish = (): void => {
        controller?.close();
        for (const track of screenStreamRef.current?.getTracks() ?? []) track.stop();
        for (const track of localStreamRef.current?.getTracks() ?? []) track.stop();
      };
      if (transcription) void transcription.stop().then(() => transcription.destroy()).finally(finish);
      else finish();
    };
  }, []);

  useEffect(() => {
    const onUnload = (): void => {
      const transcription = transcriptionRef.current;
      const finish = (): void => {
        controllerRef.current?.close();
        for (const track of screenStreamRef.current?.getTracks() ?? []) track.stop();
        for (const track of localStreamRef.current?.getTracks() ?? []) track.stop();
      };
      if (transcription) void transcription.stop().then(() => transcription.destroy()).finally(finish);
      else finish();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  const prepareMedia = useCallback(async (): Promise<MediaStream> => {
    if (localStreamRef.current) return localStreamRef.current;
    setError(null);
    // Browser echo cancellation keeps the remote participants' voices out of the
    // local microphone track, so only this participant's own speech is transcribed.
    const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio,
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    }
    for (const track of stream.getAudioTracks()) track.enabled = micRef.current;
    for (const track of stream.getVideoTracks()) track.enabled = cameraRef.current;
    localStreamRef.current = stream;
    setLocalStream(stream);
    return stream;
  }, []);

  const startTranscription = async (stream: MediaStream): Promise<void> => {
    if (!settingsRef.current.captionsEnabled) return;
    const microphone = stream.getAudioTracks()[0];
    if (!microphone) {
      setTranscription({ status: 'error', error: { code: 'NO_MICROPHONE', message: 'No microphone track is available for captions.' } });
      return;
    }
    // The first token also tells the page which provider the Worker is configured for.
    let issued: IssuedToken;
    try {
      issued = await requestTranscriptionToken();
    } catch (cause) {
      setTranscription({
        status: 'error',
        error: { code: 'TOKEN_UNAVAILABLE', message: cause instanceof Error ? cause.message : 'Captions are unavailable.' },
      });
      return;
    }
    if (localStreamRef.current !== stream) return;
    let pending: Credential | null = { type: 'ephemeral-token', value: issued.token };
    const transcription = createTranscription({
      credential: async () => {
        const credential = pending;
        pending = null;
        if (credential) return credential;
        return { type: 'ephemeral-token', value: (await requestTranscriptionToken()).token };
      },
      options: { provider: issued.provider },
    });
    transcriptionRef.current = transcription;
    sessionIdRef.current = null;
    cursorRef.current = 0;
    interimRef.current = '';
    transcription.addAudioSource(microphone, { id: 'microphone' });
    unsubscribeRef.current = transcription.subscribe(handleTranscriptionState);
    const result = await transcription.start(transcriptionOverrides(settingsRef.current));
    if (!result.ok) console.warn(`[Weave In] Captions unavailable: ${result.code} ${result.message}`);
  };

  /** Re-applies caption settings to the live session: toggles it off/on or restarts it with new options. */
  const applyTranscriptionSettings = async (): Promise<void> => {
    const stream = localStreamRef.current;
    if (phaseRef.current !== 'room' || !stream) return;
    const generation = ++restartGenerationRef.current;
    const next = settingsRef.current;
    if (!next.captionsEnabled) {
      await stopTranscription();
      if (generation === restartGenerationRef.current) setTranscription(IDLE_TRANSCRIPTION);
      return;
    }
    const transcription = transcriptionRef.current;
    if (!transcription) {
      await startTranscription(stream);
      return;
    }
    await transcription.stop();
    if (generation !== restartGenerationRef.current || transcriptionRef.current !== transcription) return;
    const result = await transcription.start(transcriptionOverrides(next));
    if (!result.ok) console.warn(`[Weave In] Captions could not restart: ${result.code} ${result.message}`);
  };

  const updateSettings = (patch: Partial<MeetingSettings>): void => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    writeSettings(next);
  };

  const openSettings = (): void => {
    settingsAtOpenRef.current = settingsRef.current;
    setSettingsOpen(true);
  };

  const closeSettings = useCallback((): void => {
    setSettingsOpen(false);
    const before = settingsAtOpenRef.current;
    settingsAtOpenRef.current = null;
    if (before && transcriptionSettingsChanged(before, settingsRef.current)) void applyTranscriptionSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enterRoom = useCallback(async (action: 'create' | 'join'): Promise<void> => {
    const name = normalizeDisplayName(displayName);
    if (!name) {
      setError('Enter a display name between 1 and 40 characters.');
      return;
    }
    const code = action === 'create' ? createRoomCode() : roomInput.trim().toUpperCase();
    if (!ROOM_CODE_PATTERN.test(code)) {
      setError('Room codes contain exactly six uppercase letters or numbers.');
      return;
    }
    setError(null);
    setPhase('connecting');
    nameRef.current = name;
    storeDisplayName(name);
    try {
      const stream = await prepareMedia();
      const controller = new MeetingController([stream], {
        onConnected: (self, initialPeers, startedAt) => {
          setRoomStartedAt(startedAt);
          selfRef.current = self;
          const next = Object.fromEntries(initialPeers.map((peer) => [peer.peerId, { identity: peer, seat: seatFor(peer.peerId), streams: {}, media: null }]));
          participantsRef.current = next;
          setParticipants(next);
          const at = new Date().toISOString();
          setJoinedAt(at);
          syncingRef.current = new Set(initialPeers.map((peer) => peer.peerId));
          newcomersRef.current.clear();
          seenRef.current.clear();
          for (const peer of initialPeers) {
            logRef.current.append({ kind: 'presence', at, participant: { peerId: peer.peerId, name: peer.name }, event: 'present' });
          }
          logRef.current.append({ kind: 'presence', at, participant: { peerId: self.peerId, name: self.name }, event: 'joined' });
        },
        onPeerJoined: (peer) => {
          setParticipants((current) => {
            const next = { ...current, [peer.peerId]: { identity: peer, seat: seatFor(peer.peerId), streams: {}, media: null } };
            participantsRef.current = next;
            return next;
          });
          logRef.current.append({ kind: 'presence', at: new Date().toISOString(), participant: { peerId: peer.peerId, name: peer.name }, event: 'joined' });
          newcomersRef.current.add(peer.peerId);
        },
        onPeerLeft: (peerId) => {
          logRef.current.append({ kind: 'presence', at: new Date().toISOString(), participant: logParticipant(peerId), event: 'left' });
          fileShareRef.current?.peerLeft(peerId);
          newcomersRef.current.delete(peerId);
          syncingRef.current.delete(peerId);
          setParticipants((current) => {
            const next = omitKey(current, peerId);
            participantsRef.current = next;
            return next;
          });
          setInterims((current) => omitKey(current, peerId));
          setCaptions((current) => omitKey(current, peerId));
        },
        onRemoteStream: (peerId, stream) => {
          setParticipants((current) => {
            const participant = current[peerId];
            if (!participant) return current;
            const next = { ...current, [peerId]: { ...participant, streams: { ...participant.streams, [stream.id]: stream } } };
            participantsRef.current = next;
            return next;
          });
        },
        onRemoteStreamEnded: (peerId, streamId) => {
          setParticipants((current) => {
            const participant = current[peerId];
            if (!participant) return current;
            const next = { ...current, [peerId]: { ...participant, streams: omitKey(participant.streams, streamId) } };
            participantsRef.current = next;
            return next;
          });
        },
        onPeerChannelOpen: (peerId) => {
          controllerRef.current?.send(peerId, { type: 'state', ...currentMediaState() });
          fileShareRef.current?.announceTo(peerId);
          if (newcomersRef.current.has(peerId)) replayHistoryTo(peerId);
        },
        onPeerChannel: (peerId, channel) => {
          if (!fileShareRef.current?.handleChannel(peerId, channel)) channel.close();
        },
        onPeerMessage: handlePeerMessage,
        onError: (_code, message) => setError(message),
      });
      controllerRef.current = controller;
      fileShareRef.current?.close();
      fileShareRef.current = new FileShare(
        {
          send: (peerId, message) => controller.send(peerId, message),
          broadcast: (message) => controller.broadcast(message),
          openChannel: (peerId, label) => controller.openChannel(peerId, label),
        },
        setFiles,
      );
      await controller.connect({ roomCode: code, action, displayName: name, peerId: createPeerId() });
      roomCodeRef.current = code;
      setRoomCode(code);
      setRoomInput(code);
      syncRoomUrl(code);
      setPhase('room');
      void startTranscription(stream);
    } catch (cause) {
      controllerRef.current?.close();
      controllerRef.current = null;
      fileShareRef.current?.close();
      fileShareRef.current = null;
      logRef.current.clear();
      setError(cause instanceof Error ? cause.message : 'Unable to enter the room.');
      setPhase('lobby');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayName, prepareMedia, roomInput]);

  const leaveMeeting = useCallback(async (): Promise<void> => {
    if (phase === 'leaving') return;
    setPhase('leaving');
    setError(null);
    await stopTranscription();
    controllerRef.current?.close();
    controllerRef.current = null;
    fileShareRef.current?.close();
    fileShareRef.current = null;
    logRef.current.clear();
    selfRef.current = null;
    roomCodeRef.current = '';
    newcomersRef.current.clear();
    syncingRef.current.clear();
    seenRef.current.clear();
    setJoinedAt(null);
    setRoomStartedAt(null);
    releaseLocalMedia();
    participantsRef.current = {};
    seatsRef.current.clear();
    nextSeatRef.current = 1;
    setParticipants({});
    privateNotices.clear();
    setMessages([]);
    setFiles({});
    setTranscript([]);
    setInterims({});
    setCaptions({});
    setTranscription(IDLE_TRANSCRIPTION);
    setRoomCode('');
    syncRoomUrl(null);
    setPhase('lobby');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const toggleMic = (): void => {
    const next = !micRef.current;
    micRef.current = next;
    for (const track of localStreamRef.current?.getAudioTracks() ?? []) track.enabled = next;
    setMicEnabled(next);
    broadcastMediaState();
  };

  const toggleCamera = (): void => {
    const next = !cameraRef.current;
    cameraRef.current = next;
    for (const track of localStreamRef.current?.getVideoTracks() ?? []) track.enabled = next;
    setCameraEnabled(next);
    broadcastMediaState();
  };

  const toggleScreenShare = async (): Promise<void> => {
    if (screenStreamRef.current) {
      stopScreenShare();
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
    } catch {
      return;
    }
    const [track] = stream.getVideoTracks();
    if (!track || !controllerRef.current) {
      for (const item of stream.getTracks()) item.stop();
      return;
    }
    track.addEventListener('ended', stopScreenShare, { once: true });
    screenStreamRef.current = stream;
    setScreenStream(stream);
    controllerRef.current.addStream(stream);
    broadcastMediaState();
  };

  /** Posts to chat; `agent` names the assistant when the message comes through a WebMCP tool rather than the keyboard. */
  const sendChat = (text: string, agent: string | null = null): { id: string; at: string } => {
    const message = { id: crypto.randomUUID(), text, at: new Date().toISOString(), agent };
    setMessages((current) => [...current, { kind: 'text', ...message, from: SELF, name: nameRef.current, color: colorFor(SELF), own: true }]);
    controllerRef.current?.broadcast({ type: 'chat', ...message });
    logRef.current.append({ kind: 'chat', at: message.at, sender: logParticipant(SELF), text, agent });
    return { id: message.id, at: message.at };
  };

  const shareFiles = (picked: File[]): void => {
    const share = fileShareRef.current;
    if (!share || phaseRef.current !== 'room') return;
    for (const file of picked) {
      if (file.size > MAX_FILE_BYTES) {
        setError(`“${file.name}” is ${formatMegabytes(file.size)} MB. Files up to ${formatMegabytes(MAX_FILE_BYTES)} MB can be shared.`);
        continue;
      }
      if (file.size === 0) {
        setError(`“${file.name}” is empty.`);
        continue;
      }
      const shared = share.share(file);
      setMessages((current) => [
        ...current,
        { kind: 'file', id: shared.id, from: SELF, name: nameRef.current, color: colorFor(SELF), at: shared.at, own: true, fileId: shared.id },
      ]);
      logRef.current.append({
        kind: 'file',
        at: shared.at,
        sender: logParticipant(SELF),
        file: { id: shared.id, name: shared.name, size: shared.size, mime: shared.mime },
      });
    }
  };

  const downloadFile = (id: string): void => {
    void fileShareRef.current?.download(id).catch(() => undefined);
  };

  /** The screen being presented right now: this participant's own share first, otherwise the first remote one. */
  const currentPresentation = (): { stream: MediaStream; presenter: LogParticipant & { you: boolean } } | null => {
    const local = screenStreamRef.current;
    if (local) return { stream: local, presenter: { ...logParticipant(SELF), you: true } };
    for (const participant of Object.values(participantsRef.current)) {
      const screenId = participant.media?.screenStreamId;
      const stream = screenId ? participant.streams[screenId] : undefined;
      if (stream) return { stream, presenter: { peerId: participant.identity.peerId, name: participant.identity.name, you: false } };
    }
    return null;
  };

  const captureScreen = async (options: Parameters<typeof captureVideoFrame>[1]): Promise<ScreenCapture | null> => {
    const presentation = currentPresentation();
    if (!presentation) return null;
    const frame = await captureVideoFrame(presentation.stream, options);
    return { ...frame, presenter: presentation.presenter };
  };

  /** What the WebMCP tools see: this browser's current view of the room. */
  const meetingSnapshot = (): MeetingSnapshot => {
    const you = logParticipant(SELF);
    const remote = Object.values(participantsRef.current).map((participant) => ({
      peerId: participant.identity.peerId,
      name: participant.identity.name,
      you: false,
      isHost: participant.identity.isHost,
      micOn: participant.media?.micOn ?? null,
      cameraOn: participant.media?.cameraOn ?? null,
      sharingScreen: Boolean(participant.media?.screenStreamId),
    }));
    return {
      roomCode: roomCodeRef.current,
      you,
      participants: [
        { ...you, you: true, isHost: selfRef.current?.isHost ?? false, micOn: micRef.current, cameraOn: cameraRef.current, sharingScreen: Boolean(screenStreamRef.current) },
        ...remote,
      ],
      captions: transcriptionRef2.current.status,
      presentation: currentPresentation()?.presenter ?? null,
      live: Object.entries(interimsRef.current)
        .filter(([, interim]) => interim.text)
        .map(([peerId, interim]) => ({ ...logParticipant(peerId), text: interim.text })),
      files: Object.values(filesRef.current).map((file) => ({
        id: file.id,
        name: file.name,
        size: file.size,
        mime: file.mime,
        at: file.at,
        sharedBy: logParticipant(file.owner),
        status: file.status,
      })),
    };
  };

  useEffect(() => {
    if (phase !== 'room') return;
    const timer = window.setInterval(() => privateNotices.expire(), 1000);
    const unregister = registerMeetingTools({
      privateNotices,
      snapshot: meetingSnapshot,
      log: () => logRef.current,
      download: async (fileId) => {
        const share = fileShareRef.current;
        if (!share) throw new Error('The meeting has ended.');
        const blob = await share.download(fileId);
        const file = share.get(fileId);
        if (!file) throw new Error('That file is not part of this meeting.');
        return { file, blob };
      },
      captureScreen,
      sendAgentMessage: (text, agent) => sendChat(text, agent ?? 'Assistant'),
    });
    return () => { window.clearInterval(timer); unregister?.(); privateNotices.clear(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const settingsDialog = (
    <SettingsDialog open={settingsOpen} settings={settings} onChange={updateSettings} onClose={closeSettings} />
  );

  if (phase === 'room' || phase === 'leaving') {
    return (
      <>
      <MeetingSurface
        roomCode={roomCode}
        displayName={nameRef.current}
        localStream={localStream}
        screenStream={screenStream}
        participants={participants}
        micEnabled={micEnabled}
        cameraEnabled={cameraEnabled}
        captions={captions}
        transcription={transcription}
        messages={messages}
        files={files}
        transcript={transcript}
        interims={interims}
        joinedAt={joinedAt}
        roomStartedAt={roomStartedAt}
        privateNotices={privateNotices}
        panelTab={panelTab}
        error={error}
        leaving={phase === 'leaving'}
        onToggleMic={toggleMic}
        onToggleCamera={toggleCamera}
        onToggleScreen={() => void toggleScreenShare()}
        onSendChat={(text) => void sendChat(text)}
        onShareFiles={shareFiles}
        onDownloadFile={downloadFile}
        onPanelTab={setPanelTab}
        onOpenSettings={openSettings}
        onCopy={() => void navigator.clipboard.writeText(roomLink(roomCode))}
        onLeave={() => void leaveMeeting()}
      />
      {settingsDialog}
      </>
    );
  }
  return (
    <>
    <LandingSurface
      displayName={displayName}
      roomCode={roomInput}
      invitedRoom={invitedRoom}
      localStream={localStream}
      micEnabled={micEnabled}
      cameraEnabled={cameraEnabled}
      connecting={phase === 'connecting'}
      error={error}
      onDisplayNameChange={(value) => {
        setDisplayName(value);
        storeDisplayName(value);
      }}
      onRoomCodeChange={(value) => setRoomInput(value.toUpperCase().slice(0, 6))}
      onPreview={() => void prepareMedia().catch(() => setError('Camera and microphone access is required.'))}
      onToggleMic={toggleMic}
      onToggleCamera={toggleCamera}
      onOpenSettings={openSettings}
      onCreate={() => void enterRoom('create')}
      onJoin={() => void enterRoom('join')}
    />
    {settingsDialog}
    </>
  );
}

function MeetingSurface(props: {
  privateNotices: PrivateNotices;
  roomCode: string;
  displayName: string;
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
  participants: Record<string, RemoteParticipant>;
  micEnabled: boolean;
  cameraEnabled: boolean;
  captions: Record<string, CaptionState>;
  transcription: TranscriptionView;
  messages: ChatMessage[];
  files: Record<string, SharedFile>;
  transcript: TranscriptLine[];
  interims: Record<string, LiveInterim>;
  joinedAt: string | null;
  roomStartedAt: number | null;
  panelTab: SidePanelTab;
  error: string | null;
  leaving: boolean;
  onToggleMic(): void;
  onToggleCamera(): void;
  onToggleScreen(): void;
  onSendChat(text: string): void;
  onShareFiles(files: File[]): void;
  onDownloadFile(id: string): void;
  onPanelTab(tab: SidePanelTab): void;
  onOpenSettings(): void;
  onCopy(): void;
  onLeave(): void;
}): ReactNode {
  const participants = Object.values(props.participants);
  const presentation = findPresentation(props.screenStream, props.displayName, participants);
  const tiles = [
    <VideoTile
      key={SELF}
      name={props.displayName}
      stream={props.localStream}
      muted={!props.micEnabled}
      cameraOff={
        !props.cameraEnabled ||
        !props.localStream?.getVideoTracks().some((track) => track.readyState === 'live')
      }
      caption={props.captions[SELF] ?? null}
      style={threadStyle(0)}
      local
    />,
    ...participants.map((participant) => {
      const camera = cameraStreamFor(participant);
      return (
        <VideoTile
          key={participant.identity.peerId}
          name={participant.identity.name}
          stream={camera}
          muted={participant.media ? !participant.media.micOn : false}
          cameraOff={participant.media ? !participant.media.cameraOn : !camera?.getVideoTracks().length}
          caption={props.captions[participant.identity.peerId] ?? null}
          style={threadStyle(participant.seat)}
        />
      );
    }),
  ];
  return (
    <main className="meeting-shell">
      <RoomHeader
        roomCode={props.roomCode}
        startedAt={props.roomStartedAt}
        people={participants.length + 1}
        transcription={props.transcription}
        onOpenSettings={props.onOpenSettings}
        onCopy={props.onCopy}
        onLeave={props.onLeave}
      />
      <div className="meeting-body">
        <section className="meeting-stage">
          {presentation ? (
            <div className="stage-presentation">
              <div className="stage-presentation__screen">
                <VideoTile name={presentation.name} stream={presentation.stream} muted={false} cameraOff={false} local={presentation.local} presentation />
              </div>
              <div className="stage-presentation__strip">{tiles}</div>
            </div>
          ) : (
            <div className="video-grid" data-count={Math.min(tiles.length, 8)}>{tiles}</div>
          )}
          {(props.error || props.transcription.error) && (
            <ErrorNotice message={props.error ?? props.transcription.error?.message ?? 'Something went wrong.'} />
          )}
          <PrivateNoticeDock store={props.privateNotices} onHistory={() => props.onPanelTab('private')} />
          <MeetingControls
            micEnabled={props.micEnabled}
            cameraEnabled={props.cameraEnabled}
            sharingScreen={Boolean(props.screenStream)}
            canShareScreen={typeof navigator.mediaDevices?.getDisplayMedia === 'function'}
            onToggleMic={props.onToggleMic}
            onToggleCamera={props.onToggleCamera}
            onToggleScreen={props.onToggleScreen}
          />
          <p className="stage-caption"><LockKeyhole size={13} /> Full-mesh WebRTC · direct between browsers</p>
        </section>
        <SidePanel
          privateNotices={props.privateNotices}
          tab={props.panelTab}
          onTabChange={props.onPanelTab}
          messages={props.messages}
          files={props.files}
          transcript={props.transcript}
          interims={props.interims}
          joinedAt={props.joinedAt}
          onSendChat={props.onSendChat}
          onShareFiles={props.onShareFiles}
          onDownloadFile={props.onDownloadFile}
        />
      </div>
      {props.leaving && <div className="leaving-overlay"><LoaderCircle className="spinner" size={24} /><span>Releasing local resources…</span></div>}
    </main>
  );
}

function findPresentation(
  localScreen: MediaStream | null,
  localName: string,
  participants: RemoteParticipant[],
): Presentation | null {
  if (localScreen) return { name: localName, stream: localScreen, local: true };
  for (const participant of participants) {
    const screenId = participant.media?.screenStreamId;
    const stream = screenId ? participant.streams[screenId] : undefined;
    if (stream) return { name: participant.identity.name, stream, local: false };
  }
  return null;
}

function cameraStreamFor(participant: RemoteParticipant): MediaStream | null {
  const cameraId = participant.media?.cameraStreamId;
  if (cameraId) return participant.streams[cameraId] ?? null;
  return Object.values(participant.streams).find((stream) => stream.getAudioTracks().length > 0) ?? null;
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

async function requestTranscriptionToken(): Promise<IssuedToken> {
  const response = await fetch('/api/transcription-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (response.status === 503) {
    throw new Error('Captions are unavailable: this deployment has no caption provider configured.');
  }
  if (!response.ok) throw new Error('The meeting could not obtain a temporary transcription token.');
  const payload: unknown = await response.json();
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  const provider = record?.['provider'];
  const token = typeof record?.['token'] === 'string' ? record['token'].trim() : '';
  if ((provider !== 'gemini' && provider !== 'openai') || !token) {
    throw new Error('The meeting received an invalid token response.');
  }
  return { provider, token };
}

/** Reads `?room=CODE` from an invite link; anything malformed is ignored. */
function readRoomCodeFromUrl(): string {
  try {
    const code = new URL(window.location.href).searchParams.get(ROOM_QUERY_PARAM)?.trim().toUpperCase() ?? '';
    return ROOM_CODE_PATTERN.test(code) ? code : '';
  } catch {
    return '';
  }
}

/** Builds the shareable invite link for a room on this origin. */
function roomLink(code: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set(ROOM_QUERY_PARAM, code);
  return url.toString();
}

/** Keeps the address bar in sync so a refresh or a copied URL lands in the same room. */
function syncRoomUrl(code: string | null): void {
  try {
    const url = new URL(window.location.href);
    if (code) url.searchParams.set(ROOM_QUERY_PARAM, code);
    else url.searchParams.delete(ROOM_QUERY_PARAM);
    window.history.replaceState(null, '', url.toString());
  } catch {
    // History may be unavailable in some embedded contexts; the link is still copyable.
  }
}

function readStoredDisplayName(): string {
  try {
    return window.localStorage.getItem(DISPLAY_NAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeDisplayName(value: string): void {
  try {
    const normalized = value.trim().slice(0, 40);
    if (normalized) window.localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, normalized);
    else window.localStorage.removeItem(DISPLAY_NAME_STORAGE_KEY);
  } catch {
    // Storage may be unavailable (private mode, blocked site data); the name simply is not remembered.
  }
}

function formatMegabytes(size: number): string {
  return (size / (1024 * 1024)).toFixed(size % (1024 * 1024) === 0 ? 0 : 1);
}

function clipCaption(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= 280) return normalized;
  return `…${normalized.slice(-279).trimStart()}`;
}
