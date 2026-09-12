import type { TranscriptionStatus } from '@weave-in/transcribe';
import {
  AlertCircle,
  Bot,
  Camera,
  CameraOff,
  Captions,
  Check,
  Link,
  MessageSquare,
  Mic,
  MicOff,
  Paperclip,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Send,
  Settings,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { MAX_CHAT_CHARACTERS, MAX_FILE_BYTES, MAX_PARTICIPANTS, normalizeChatText } from './protocol';
import { Brand } from './brand';
import { formatBytes, type SharedFile } from './file-share';
import { FileCard } from './file-card';
import { Markdown } from './markdown';
import { compareTime } from './history';
import { LANGUAGE_OPTIONS, MAX_SELECTED_LANGUAGES, type MeetingSettings } from './settings';
import { observeVoiceActivity } from './voice-activity';
import { MeetingTimer } from './meeting-timer';

const CAPTION_LINGER_MS = 6_000;

export interface CaptionState {
  text: string;
  final: boolean;
  at: number;
}

interface ChatMessageBase {
  id: string;
  from: string;
  name: string;
  color: string;
  at: string;
  own: boolean;
}

/** A chat entry is either typed text (possibly posted by the sender's agent) or a shared file. */
export type ChatMessage =
  | (ChatMessageBase & { kind: 'text'; text: string; agent: string | null })
  | (ChatMessageBase & { kind: 'file'; fileId: string });

export interface TranscriptLine {
  id: string;
  from: string;
  name: string;
  color: string;
  text: string;
  at: string;
  own: boolean;
}

export interface LiveInterim {
  name: string;
  color: string;
  text: string;
}

export interface TranscriptionView {
  status: TranscriptionStatus;
  error: { code: string; message: string } | null;
}

export type SidePanelTab = 'chat' | 'transcript';

export function VideoTile({
  name,
  stream,
  muted,
  cameraOff,
  local = false,
  presentation = false,
  caption = null,
  style,
}: {
  name: string;
  stream: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  local?: boolean;
  presentation?: boolean;
  caption?: CaptionState | null;
  style?: CSSProperties;
}): ReactNode {
  const video = useRef<HTMLVideoElement>(null);
  const tile = useRef<HTMLElement>(null);
  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
  }, [stream]);
  useVoiceActivity(presentation ? null : stream, tile);
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  const hidden = cameraOff || !stream;
  return (
    <article
      ref={tile}
      className={`video-tile-shell ${presentation ? 'video-tile-shell--presentation' : ''}`}
      data-testid={local ? 'local-tile' : 'remote-tile'}
      data-local={local ? 'true' : undefined}
      style={style}
    >
      <div className="video-tile">
        <video ref={video} autoPlay playsInline muted={local} hidden={hidden} />
        {hidden && <div className="video-tile__avatar" aria-hidden="true">{initial}</div>}
        <div className="video-tile__shade" />
        <CaptionBubble caption={caption} />
        <div className="video-tile__meta">
          <span>{name}{local ? ' · You' : ''}{presentation ? ' · Presenting' : ''}</span>
          {muted && !presentation && <MicOff size={14} aria-label="Microphone muted" />}
        </div>
      </div>
    </article>
  );
}

function CaptionBubble({ caption }: { caption: CaptionState | null }): ReactNode {
  const [expiredAt, setExpiredAt] = useState<number | null>(null);
  useEffect(() => {
    if (!caption?.final) return;
    const timer = window.setTimeout(() => setExpiredAt(caption.at), CAPTION_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [caption]);
  if (!caption?.text || (caption.final && expiredAt === caption.at)) return null;
  return (
    <p className={`tile-caption ${caption.final ? '' : 'is-interim'}`} aria-live="polite" data-testid="tile-caption">
      {caption.text}
    </p>
  );
}

export function RoomHeader({
  roomCode,
  startedAt,
  people,
  transcription,
  onOpenSettings,
  onCopy,
  onLeave,
}: {
  roomCode: string;
  startedAt: number | null;
  people: number;
  transcription: TranscriptionView;
  onOpenSettings(): void;
  onCopy(): void;
  onLeave(): void;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    onCopy();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_600);
  };
  return (
    <header className="room-header">
      <Brand compact />
      <div className="room-header__identity">
        <span className="data-label">Room</span>
        <strong className="room-code">{roomCode}</strong>
      </div>
      <div className="room-header__status">
        <div
          className={`caption-status is-${transcription.status}`}
          role="status"
          aria-live="polite"
          title={captionStatusDescription(transcription)}
        >
          <Captions size={14} />
          <i className="caption-status__dot" aria-hidden="true" />
          <span>{captionStatusLabel(transcription)}</span>
        </div>
        {startedAt !== null && <MeetingTimer startedAt={startedAt} />}
      </div>
      <div className="room-header__spacer" />
      <span className="people-count"><Users size={15} /> {people}/{MAX_PARTICIPANTS}</span>
      <button className="icon-button" type="button" onClick={onOpenSettings} aria-label="Settings" title="Settings">
        <Settings size={17} />
      </button>
      <button className="icon-button icon-button--wide" type="button" onClick={copy} aria-label="Copy meeting link" title="Copy an invite link that opens this room">
        {copied ? <Check size={17} /> : <Link size={17} />}<span>{copied ? 'Link copied' : 'Copy link'}</span>
      </button>
      <button className="icon-button icon-button--danger icon-button--leave" type="button" onClick={onLeave} aria-label="Leave meeting">
        <PhoneOff size={17} /><span>Leave</span>
      </button>
    </header>
  );
}

export function PreviewControls({
  micEnabled,
  cameraEnabled,
  onToggleMic,
  onToggleCamera,
}: {
  micEnabled: boolean;
  cameraEnabled: boolean;
  onToggleMic(): void;
  onToggleCamera(): void;
}): ReactNode {
  return (
    <nav className="preview-controls" aria-label="Preview controls">
      <button
        className={`preview-toggle ${micEnabled ? '' : 'is-off'}`}
        type="button"
        onClick={onToggleMic}
        aria-label={micEnabled ? 'Mute microphone' : 'Unmute microphone'}
        aria-pressed={!micEnabled}
      >
        {micEnabled ? <Mic size={18} /> : <MicOff size={18} />}
      </button>
      <button
        className={`preview-toggle ${cameraEnabled ? '' : 'is-off'}`}
        type="button"
        onClick={onToggleCamera}
        aria-label={cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
        aria-pressed={!cameraEnabled}
      >
        {cameraEnabled ? <Camera size={18} /> : <CameraOff size={18} />}
      </button>
    </nav>
  );
}

export function MeetingControls({
  micEnabled,
  cameraEnabled,
  sharingScreen,
  canShareScreen,
  onToggleMic,
  onToggleCamera,
  onToggleScreen,
}: {
  micEnabled: boolean;
  cameraEnabled: boolean;
  sharingScreen: boolean;
  canShareScreen: boolean;
  onToggleMic(): void;
  onToggleCamera(): void;
  onToggleScreen(): void;
}): ReactNode {
  return (
    <nav className="meeting-controls" aria-label="Meeting controls">
      <button className={`transport-button ${micEnabled ? '' : 'is-off'}`} type="button" onClick={onToggleMic} aria-pressed={!micEnabled}>
        {micEnabled ? <Mic size={20} /> : <MicOff size={20} />}<span>{micEnabled ? 'Mute' : 'Unmute'}</span>
      </button>
      <button className={`transport-button ${cameraEnabled ? '' : 'is-off'}`} type="button" onClick={onToggleCamera} aria-pressed={!cameraEnabled}>
        {cameraEnabled ? <Camera size={20} /> : <CameraOff size={20} />}<span>{cameraEnabled ? 'Camera off' : 'Camera on'}</span>
      </button>
      <button
        className={`transport-button ${sharingScreen ? 'is-active' : ''}`}
        type="button"
        onClick={onToggleScreen}
        aria-pressed={sharingScreen}
        disabled={!canShareScreen}
        title={canShareScreen ? undefined : 'Screen sharing is not available in this browser.'}
      >
        {sharingScreen ? <ScreenShareOff size={20} /> : <ScreenShare size={20} />}<span>{sharingScreen ? 'Stop sharing' : 'Share screen'}</span>
      </button>
    </nav>
  );
}

export function SidePanel({
  tab,
  onTabChange,
  messages,
  files,
  transcript,
  interims,
  joinedAt,
  onSendChat,
  onShareFiles,
  onDownloadFile,
}: {
  tab: SidePanelTab;
  onTabChange(tab: SidePanelTab): void;
  messages: ChatMessage[];
  files: Record<string, SharedFile>;
  transcript: TranscriptLine[];
  interims: Record<string, LiveInterim>;
  joinedAt: string | null;
  onSendChat(text: string): void;
  onShareFiles(files: File[]): void;
  onDownloadFile(id: string): void;
}): ReactNode {
  return (
    <aside className="side-panel" aria-label="Meeting panel">
      <div className="side-panel__tabs" role="tablist">
        <button role="tab" type="button" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'is-active' : ''} onClick={() => onTabChange('chat')}>
          <MessageSquare size={15} /> Chat{messages.length > 0 && <em>{messages.length}</em>}
        </button>
        <button role="tab" type="button" aria-selected={tab === 'transcript'} className={tab === 'transcript' ? 'is-active' : ''} onClick={() => onTabChange('transcript')}>
          <Captions size={15} /> Transcript{transcript.length > 0 && <em>{transcript.length}</em>}
        </button>
      </div>
      {tab === 'chat'
        ? <ChatPanel messages={messages} files={files} joinedAt={joinedAt} onSend={onSendChat} onShareFiles={onShareFiles} onDownloadFile={onDownloadFile} />
        : <TranscriptPanel transcript={transcript} interims={interims} joinedAt={joinedAt} />}
    </aside>
  );
}

export function SettingsDialog({
  open,
  settings,
  onChange,
  onClose,
}: {
  open: boolean;
  settings: MeetingSettings;
  onChange(patch: Partial<MeetingSettings>): void;
  onClose(): void;
}): ReactNode {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;

  const selected = new Set(settings.languageCodes);
  const limitReached = selected.size >= MAX_SELECTED_LANGUAGES;
  const toggleLanguage = (code: string): void => {
    onChange({
      languageCodes: selected.has(code)
        ? settings.languageCodes.filter((item) => item !== code)
        : [...settings.languageCodes, code],
    });
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        data-testid="settings-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog__header">
          <h2 id="settings-title">Settings</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close settings" autoFocus>
            <X size={17} />
          </button>
        </header>

        <div className="settings-section">
          <label className="switch-row">
            <span>
              <strong>Live captions</strong>
              <small>Transcribe my microphone locally and share the text with the room.</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={settings.captionsEnabled}
              onChange={(event) => onChange({ captionsEnabled: event.target.checked })}
            />
          </label>
        </div>

        <div className={`settings-section ${settings.captionsEnabled ? '' : 'is-disabled'}`}>
          <h3>Languages I speak</h3>
          <p className="settings-hint">
            {selected.size === 0 ? 'Auto-detect is on. ' : ''}
            Pick up to {MAX_SELECTED_LANGUAGES} to improve accuracy for mixed-language speech.
          </p>
          <div className="language-grid" role="group" aria-label="Transcription languages">
            {LANGUAGE_OPTIONS.map((option) => {
              const checked = selected.has(option.code);
              return (
                <label key={option.code} className={`language-option ${checked ? 'is-selected' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && limitReached}
                    onChange={() => toggleLanguage(option.code)}
                  />
                  <span className="language-option__native">{option.native}</span>
                  <span className="language-option__label">{option.label}</span>
                </label>
              );
            })}
          </div>
        </div>

        <div className={`settings-section ${settings.captionsEnabled ? '' : 'is-disabled'}`}>
          <h3>Caption style</h3>
          <div className="segmented" role="radiogroup" aria-label="Caption style">
            <button type="button" role="radio" aria-checked={settings.mode === 'VERBATIM'} onClick={() => onChange({ mode: 'VERBATIM' })}>Verbatim</button>
            <button type="button" role="radio" aria-checked={settings.mode === 'SMART'} onClick={() => onChange({ mode: 'SMART' })}>Smart</button>
          </div>
          <p className="settings-hint">Verbatim keeps every word as spoken. Smart adds punctuation and trims filler words.</p>
        </div>

        <footer className="dialog__footer">
          <span className="settings-hint">Saved in this browser. Changes take effect when you close this panel.</span>
          <button className="primary-button" type="button" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}

function ChatPanel({
  messages,
  files,
  joinedAt,
  onSend,
  onShareFiles,
  onDownloadFile,
}: {
  messages: ChatMessage[];
  files: Record<string, SharedFile>;
  joinedAt: string | null;
  onSend(text: string): void;
  onShareFiles(files: File[]): void;
  onDownloadFile(id: string): void;
}): ReactNode {
  const [draft, setDraft] = useState('');
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const list = useAutoScroll([messages.length]);
  const divider = joinDividerIndex(messages, joinedAt);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const text = normalizeChatText(draft);
    if (!text.trim()) return;
    onSend(text);
    setDraft('');
  };
  const carriesFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  const onDragEnter = (event: DragEvent): void => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDropping(true);
  };
  const onDragOver = (event: DragEvent): void => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event: DragEvent): void => {
    if (!carriesFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropping(false);
  };
  const onDrop = (event: DragEvent): void => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDropping(false);
    onShareFiles(Array.from(event.dataTransfer.files));
  };
  return (
    <div
      className={`chat-panel ${dropping ? 'is-dropping' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-testid="chat-panel"
    >
      <ol ref={list} className="panel-list" data-testid="chat-list">
        {messages.length === 0 && <li className="panel-empty">Messages and files go directly to everyone in the room.</li>}
        {messages.map((message, index) => (
          <li
            key={`${message.from}:${message.id}`}
            className={`chat-message ${message.own ? 'is-own' : ''} ${message.kind === 'text' && message.agent ? 'is-agent' : ''} ${message.kind === 'file' ? 'is-file' : ''}`}
            data-before-join={divider !== null && index < divider ? 'true' : undefined}
          >
            <header>
              <strong style={{ color: message.color }}>
                {message.kind === 'text' && message.agent !== null
                  ? <><Bot size={12} aria-hidden="true" /> {message.own ? 'Your agent' : `${message.name}'s agent`}</>
                  : message.own ? 'You' : message.name}
              </strong>
              {message.kind === 'text' && message.agent && <span className="chat-agent-tag">{message.agent}</span>}
              <time dateTime={message.at}>{formatTime(message.at)}</time>
            </header>
            {message.kind === 'text'
              ? <Markdown text={message.text} />
              : <FileCard file={files[message.fileId]} onDownload={onDownloadFile} />}
          </li>
        ))}
        {divider !== null && <JoinDivider at={joinedAt} position={divider} />}
      </ol>
      <form className="chat-composer" onSubmit={submit}>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          data-testid="file-picker"
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (picked.length) onShareFiles(picked);
          }}
        />
        <button
          className="chat-composer__attach"
          type="button"
          onClick={() => picker.current?.click()}
          aria-label="Share a file"
          title={`Share a file with everyone (up to ${formatBytes(MAX_FILE_BYTES)})`}
        >
          <Paperclip size={16} />
        </button>
        <textarea
          aria-label="Message"
          aria-describedby="chat-compose-hint"
          placeholder="Send a message…"
          rows={2}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          value={draft}
          maxLength={MAX_CHAT_CHARACTERS}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" aria-label="Send" disabled={!draft.trim()}><Send size={16} /></button>
        <span id="chat-compose-hint" className="chat-composer__hint">Markdown supported · Shift+Enter for a new line</span>
      </form>
      {dropping && (
        <div className="drop-overlay" aria-hidden="true">
          <Paperclip size={22} />
          <strong>Drop to share with everyone</strong>
          <span>Up to {formatBytes(MAX_FILE_BYTES)} per file</span>
        </div>
      )}
    </div>
  );
}

function TranscriptPanel({
  transcript,
  interims,
  joinedAt,
}: {
  transcript: TranscriptLine[];
  interims: Record<string, LiveInterim>;
  joinedAt: string | null;
}): ReactNode {
  const live = Object.entries(interims).filter(([, interim]) => interim.text);
  const list = useAutoScroll([transcript.length, live.map(([, interim]) => interim.text).join('\n')]);
  const divider = joinDividerIndex(transcript, joinedAt);
  return (
    <ol ref={list} className="panel-list" data-testid="transcript-list">
      {transcript.length === 0 && live.length === 0 && (
        <li className="panel-empty">Each participant transcribes their own microphone and streams the text here.</li>
      )}
      {transcript.map((line, index) => (
        <li
          key={`${line.from}:${line.id}`}
          className={`transcript-line ${line.own ? 'is-own' : ''}`}
          style={{ '--thread': line.color } as CSSProperties}
          data-before-join={divider !== null && index < divider ? 'true' : undefined}
        >
          <header><strong style={{ color: line.color }}>{line.own ? 'You' : line.name}</strong><time dateTime={line.at}>{formatTime(line.at)}</time></header>
          <p>{line.text}</p>
        </li>
      ))}
      {divider !== null && <JoinDivider at={joinedAt} position={divider} />}
      {live.map(([from, interim]) => (
        <li key={`live:${from}`} className="transcript-line is-interim">
          <header><strong style={{ color: interim.color }}>{interim.name}</strong><span className="data-label">Live</span></header>
          <p>{interim.text}</p>
        </li>
      ))}
    </ol>
  );
}

/**
 * Where the "You joined" rule belongs: the number of entries that happened before this
 * participant arrived, or null when nothing was replayed. The list is rendered in order and
 * the rule is placed with CSS `order`, so entries keep stable keys.
 */
function joinDividerIndex(entries: Array<{ at: string }>, joinedAt: string | null): number | null {
  if (!joinedAt) return null;
  let count = 0;
  for (const entry of entries) {
    if (compareTime(entry.at, joinedAt) < 0) count += 1;
  }
  return count > 0 ? count : null;
}

function JoinDivider({ at, position }: { at: string | null; position: number }): ReactNode {
  return (
    <li className="panel-divider" style={{ order: position }} data-testid="join-divider" aria-label="You joined here">
      <span>You joined{at ? ` · ${formatTime(at)}` : ''}</span>
    </li>
  );
}

export function ErrorNotice({ message }: { message: string }): ReactNode {
  return <div className="error-notice" role="alert"><AlertCircle size={16} /><span>{message}</span></div>;
}

function useAutoScroll(dependencies: unknown[]): React.RefObject<HTMLOListElement | null> {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element) element.scrollTop = element.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
  return ref;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function captionStatusLabel(view: TranscriptionView): string {
  switch (view.status) {
    case 'starting': return 'Captions starting…';
    case 'transcribing': return 'Captions on';
    case 'stopping': return 'Captions stopping…';
    case 'error': return 'Captions unavailable';
    case 'stopped':
    case 'idle':
    default: return 'Captions off';
  }
}

function captionStatusDescription(view: TranscriptionView): string {
  switch (view.status) {
    case 'starting': return 'Connecting your microphone to the transcription provider.';
    case 'transcribing': return 'Your own speech is transcribed locally and shared with the room.';
    case 'stopping': return 'Transcription is stopping.';
    case 'error': return view.error?.message ?? 'Transcription stopped unexpectedly.';
    case 'stopped':
    case 'idle':
    default: return 'Transcription is not running.';
  }
}

function useVoiceActivity(stream: MediaStream | null, tile: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = tile.current;
    if (!element || !stream) return;
    let visible = true;
    let monitoredTrack: MediaStreamTrack | null = null;
    let stopMonitoring: (() => void) | null = null;
    let speaking = false;
    let renderedLevel = -1;

    const renderLevel = (level: number): void => {
      const nextSpeaking = speaking ? level >= 0.035 : level >= 0.085;
      if (Math.abs(level - renderedLevel) < 0.012 && nextSpeaking === speaking) return;
      speaking = nextSpeaking;
      renderedLevel = level;
      element.classList.toggle('is-speaking', speaking);
      element.style.setProperty('--voice-ring-inner', `${(1.5 + level * 2.5).toFixed(2)}px`);
      element.style.setProperty('--voice-ring-outer', `${(3.5 + level * 6.5).toFixed(2)}px`);
      element.style.setProperty('--voice-ring-alpha', (0.42 + level * 0.5).toFixed(3));
      element.style.setProperty('--voice-wave-alpha', (0.08 + level * 0.22).toFixed(3));
    };

    const reconcile = (): void => {
      const audioTrack = stream.getAudioTracks().find((track) => track.readyState === 'live') ?? null;
      const shouldMonitor = visible && !document.hidden && Boolean(audioTrack);
      if (shouldMonitor && audioTrack === monitoredTrack && stopMonitoring) return;
      stopMonitoring?.();
      stopMonitoring = null;
      monitoredTrack = null;
      if (!shouldMonitor || !audioTrack) {
        renderLevel(0);
        return;
      }
      monitoredTrack = audioTrack;
      stopMonitoring = observeVoiceActivity(audioTrack, renderLevel);
    };

    const visibilityObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      reconcile();
    });
    const onVisibilityChange = (): void => reconcile();
    stream.addEventListener('addtrack', reconcile);
    stream.addEventListener('removetrack', reconcile);
    document.addEventListener('visibilitychange', onVisibilityChange);
    visibilityObserver.observe(element);
    reconcile();

    return () => {
      visibilityObserver.disconnect();
      stream.removeEventListener('addtrack', reconcile);
      stream.removeEventListener('removetrack', reconcile);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopMonitoring?.();
      element.classList.remove('is-speaking');
    };
  }, [stream, tile]);
}
