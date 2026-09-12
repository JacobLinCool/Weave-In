import { ArrowRight, Camera, LoaderCircle, Settings, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Brand, THREAD_COLORS, WeaveMark } from './brand';
import { ErrorNotice, PreviewControls, VideoTile } from './components';

interface DraftThread {
  name: string;
  color: string;
}

interface DraftPick {
  thread: number;
  text: string;
}

/** Synthetic demonstration: five voices, one thread. Names and lines are invented. */
const DRAFT_THREADS: readonly DraftThread[] = [
  { name: 'Mika', color: THREAD_COLORS[1]!.hex },
  { name: 'Jun', color: THREAD_COLORS[2]!.hex },
  { name: 'Ada', color: THREAD_COLORS[3]!.hex },
  { name: 'Sam', color: THREAD_COLORS[4]!.hex },
  { name: 'You', color: THREAD_COLORS[0]!.hex },
];

const DRAFT_SCRIPT: readonly DraftPick[] = [
  { thread: 2, text: 'Recording stays off. Who is transcribing?' },
  { thread: 0, text: 'Everyone. Each of us transcribes our own microphone.' },
  { thread: 1, text: 'So the text comes straight to us?' },
  { thread: 3, text: 'Straight to us, each line in its own colour.' },
  { thread: 4, text: 'Then let me share the screen and we can start.' },
  { thread: 2, text: 'Question three: does it work in two languages at once?' },
  { thread: 0, text: 'Pick up to four. I speak Japanese and English in mine.' },
  { thread: 1, text: '日本語でも大丈夫ですか？' },
  { thread: 3, text: 'Everything you just said landed on my side, in your colour.' },
  { thread: 4, text: 'And the room lives as long as the tab.' },
  { thread: 2, text: 'Good. Then let us argue about the actual plan.' },
  { thread: 0, text: 'Weft, not warp. Keep going.' },
];

const PICK_INTERVAL_MS = 1_900;
const ADVANCE_MS = 600;
const VISIBLE_PICKS = 7;
const INITIAL_PICKS = 4;

interface LandingProps {
  displayName: string;
  roomCode: string;
  invitedRoom: string;
  localStream: MediaStream | null;
  micEnabled: boolean;
  cameraEnabled: boolean;
  connecting: boolean;
  error: string | null;
  onDisplayNameChange(value: string): void;
  onRoomCodeChange(value: string): void;
  onPreview(): void;
  onToggleMic(): void;
  onToggleCamera(): void;
  onOpenSettings(): void;
  onCreate(): void;
  onJoin(): void;
}

export function LandingSurface(props: LandingProps): ReactNode {
  return (
    <main className="landing">
      <header className="landing__header">
        <Brand />
        <nav className="landing__nav" aria-label="Page">
          <a href="#data">Where data goes</a>
          <a href="#voices">Your own voice</a>
          <a href="#spec">Specification</a>
          <button className="icon-button icon-button--wide" type="button" onClick={props.onOpenSettings} aria-label="Settings">
            <Settings size={16} /><span>Settings</span>
          </button>
        </nav>
      </header>

      <section className={`hero ${props.invitedRoom ? 'hero--invited' : ''}`} aria-labelledby="hero-title">
        <div className="hero__copy">
          <h1 id="hero-title">Keep the thread. <br />Weave everyone in.</h1>
          <p className="hero__lede">
            Meetings in the browser where every voice is transcribed on its own device and woven into one shared thread.
            Video, screen, chat, and captions connect the people in the room over encrypted WebRTC.
          </p>
        </div>
        <WeaveDraft />
        <RoomPanel {...props} />
      </section>

      <section id="data" className="sheet sheet--key" aria-labelledby="data-title">
        <div className="sheet__head">
          <h2 id="data-title">Where your data goes</h2>
          <p>A draft names every thread. These are the three this page uses.</p>
        </div>
        <dl className="key">
          <div className="key__row">
            <dt><WovenChip colors={[THREAD_COLORS[1]!.hex, THREAD_COLORS[3]!.hex]} /> Between participants</dt>
            <dd>Video, voice, screen share, chat, files, whiteboard edits, and captions travel over encrypted WebRTC connections between participants. Connections use a direct path when possible; Cloudflare TURN can relay encrypted packets when the network requires it. The relay handles connection metadata such as IP addresses and timing, but cannot read the encrypted content.</dd>
          </div>
          <div className="key__row">
            <dt><WovenChip colors={[THREAD_COLORS[0]!.hex, '#F3EEE3']} /> To AI providers</dt>
            <dd>Your microphone goes directly to your caption provider. Assistants receive their permitted context, conversation and tool results directly through OpenAI; private assistant conversations stay out of the public room.</dd>
          </div>
          <div className="key__row">
            <dt><WovenChip colors={['#303A6B', '#F3EEE3']} /> Our server</dt>
            <dd>Our signaling Worker connects browsers, issues short-lived caption and TURN credentials, and initializes and coordinates assistants. It does not carry meeting media, chat, files, or whiteboard content. Cloudflare's TURN relay is a separate data path. Automatic reminders send recent transcript text and previous reminders through the Worker to Gemini. We do not store this analysis or private conversations. You can pause automatic reminders in Chat.</dd>
          </div>
        </dl>
      </section>

      <section id="voices" className="sheet sheet--voices" aria-labelledby="voices-title">
        <div className="sheet__head">
          <h2 id="voices-title">Every voice is its own thread</h2>
          <p>Weave In transcribes each person separately, so every line already knows who said it.</p>
        </div>
        <div className="voices">
          <ul className="voices__list">
            <li>
              <h3>Your microphone only</h3>
              <p>Captions come from your own track, on your own device. Echo cancellation keeps that track yours, even with the whole room coming through your speakers.</p>
            </li>
            <li>
              <h3>In the languages you speak</h3>
              <p>Pick up to four, or let the model detect them. Switch mid-sentence and it follows you, because it hears one speaker.</p>
            </li>
            <li>
              <h3>Verbatim or smart</h3>
              <p>Keep every word as spoken, or let punctuation in and filler out. Either way the line arrives in your colour, attributed to you, on everyone&rsquo;s screen at once.</p>
            </li>
            <li>
              <h3>AI that keeps you thinking</h3>
              <p>Discuss a question privately with your assistant, or trigger the shared facilitator. It prepares a perspective, raises its hand and waits for someone to invite it to speak.</p>
            </li>
          </ul>
          <WeaveSwatch />
        </div>
      </section>

      <section id="spec" className="sheet sheet--spec" aria-labelledby="spec-title">
        <div className="sheet__head">
          <h2 id="spec-title">Draft notes</h2>
          <p>The specification, written the way a weaver writes one.</p>
        </div>
        <table className="spec">
          <tbody>
            <tr><th scope="row">Warp</th><td>Up to eight people, each in their own browser, joining with just a name.</td></tr>
            <tr><th scope="row">Sett</th><td>Full mesh: each browser connects to every other, directly or through an encrypted TURN relay.</td></tr>
            <tr><th scope="row">Weft</th><td>Camera, microphone, screen share, chat, live captions on every tile, and a merged transcript panel.</td></tr>
            <tr><th scope="row">Dye</th><td>Captions from your own microphone, in up to four languages, verbatim or smart.</td></tr>
            <tr><th scope="row">Finishing</th><td>The meeting lives as long as the tab. Your name and settings stay in your browser for next time.</td></tr>
            <tr><th scope="row">Selvedge</th><td>One link opens the room with the code already filled in.</td></tr>
          </tbody>
        </table>
      </section>

      <section className="close" aria-label="Start">
        <WeaveMark size={44} />
        <h2>Ready when you are.</h2>
        <p>A name, a room, and everyone you invite.</p>
        <a className="primary-button primary-button--large close__cta" href="#start">Create a room <ArrowRight size={18} /></a>
      </section>

      <footer className="landing__footer">
        <Brand compact />
        <button className="landing__footer-link" type="button" onClick={props.onOpenSettings}>Caption languages and style</button>
      </footer>
    </main>
  );
}

function RoomPanel(props: LandingProps): ReactNode {
  return (
    <aside id="start" className="room-panel" aria-labelledby="start-title">
      <div className="room-panel__selvedge" aria-hidden="true">
        {THREAD_COLORS.map((color) => <i key={color.name} style={{ background: color.hex }} />)}
      </div>
      <h2 id="start-title">{props.invitedRoom ? `Join room ${props.invitedRoom}` : 'Start a room'}</h2>
      <div className="preview-frame">
        {props.localStream ? (
          <VideoTile name={props.displayName || 'You'} stream={props.localStream} muted={!props.micEnabled} cameraOff={!props.cameraEnabled} local />
        ) : (
          <button className="preview-prompt" type="button" onClick={props.onPreview}>
            <Camera size={22} /><strong>Start preview</strong><span>Allow camera and microphone access.</span>
          </button>
        )}
        <PreviewControls
          micEnabled={props.micEnabled}
          cameraEnabled={props.cameraEnabled}
          onToggleMic={props.onToggleMic}
          onToggleCamera={props.onToggleCamera}
        />
      </div>
      <label className="field-label">Display name
        <input
          value={props.displayName}
          maxLength={40}
          autoComplete="name"
          placeholder="How others will see you"
          autoFocus={Boolean(props.invitedRoom)}
          onChange={(event) => props.onDisplayNameChange(event.target.value)}
        />
      </label>
      {props.invitedRoom ? (
        <>
          <p className="invite-note" data-testid="invite-note">You were invited to room <strong>{props.invitedRoom}</strong>.</p>
          <div className="join-row">
            <input className="code-input" aria-label="Room code" value={props.roomCode} placeholder="ABC123" inputMode="text" onChange={(event) => props.onRoomCodeChange(event.target.value)} />
            <button className="primary-button primary-button--join" type="button" disabled={props.connecting} onClick={props.onJoin}>
              {props.connecting ? <LoaderCircle className="spinner" size={18} /> : null} Join <ArrowRight size={17} />
            </button>
          </div>
          <div className="or-divider"><span>or start your own</span></div>
          <button className="secondary-button secondary-button--wide" type="button" disabled={props.connecting} onClick={props.onCreate}>
            <Sparkles size={17} /> Create a room
          </button>
        </>
      ) : (
        <>
          <button className="primary-button primary-button--large" type="button" disabled={props.connecting} onClick={props.onCreate}>
            {props.connecting ? <LoaderCircle className="spinner" size={18} /> : <Sparkles size={18} />} Create a room
          </button>
          <div className="or-divider"><span>or join with a code</span></div>
          <div className="join-row">
            <input className="code-input" aria-label="Room code" value={props.roomCode} placeholder="ABC123" inputMode="text" onChange={(event) => props.onRoomCodeChange(event.target.value)} />
            <button className="secondary-button" type="button" disabled={props.connecting} onClick={props.onJoin}>Join <ArrowRight size={17} /></button>
          </div>
        </>
      )}
      {props.error && <ErrorNotice message={props.error} />}
    </aside>
  );
}

/** The live draft: warps are participants, each weft pass is one caption, the drawdown is the transcript. */
function WeaveDraft(): ReactNode {
  const reducedMotion = usePrefersReducedMotion();
  const [cursor, setCursor] = useState(reducedMotion ? VISIBLE_PICKS : INITIAL_PICKS);
  // While advancing, the cloth shows one extra row at the top and slides up by one pick before dropping it.
  const [advancing, setAdvancing] = useState(false);
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (reducedMotion) {
      setCursor(VISIBLE_PICKS);
      setAdvancing(false);
      return;
    }
    let timer = 0;
    const tick = (): void => {
      if (!document.hidden) {
        setCursor((current) => {
          if (current >= VISIBLE_PICKS) setAdvancing(true);
          return current + 1;
        });
      }
      timer = window.setTimeout(tick, PICK_INTERVAL_MS);
    };
    timer = window.setTimeout(tick, PICK_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [reducedMotion]);

  useEffect(() => {
    if (!advancing) return;
    const fallback = window.setTimeout(() => setAdvancing(false), ADVANCE_MS + 120);
    return () => window.clearTimeout(fallback);
  }, [advancing, cursor]);

  const shown = advancing ? VISIBLE_PICKS + 1 : VISIBLE_PICKS;
  const start = Math.max(0, cursor - shown);
  const picks = Array.from({ length: Math.min(cursor, shown) }, (_, offset) => {
    const index = start + offset;
    return { index, pick: DRAFT_SCRIPT[index % DRAFT_SCRIPT.length]! };
  });

  return (
    <figure className="draft" aria-label="Demonstration: five participants' captions, each in its own colour, woven into one transcript">
      <div className="draft__body">
        <div className="draft__warps" aria-hidden="true">
          {DRAFT_THREADS.map((thread) => (
            <div key={thread.name} className="warp" style={{ '--thread': thread.color } as CSSProperties}>
              <span className="warp__name">{thread.name}</span>
            </div>
          ))}
        </div>
        <ol
          ref={list}
          className={`draft__picks ${advancing ? 'is-advancing' : ''}`}
          aria-live="off"
          onTransitionEnd={(event) => {
            if (event.target === list.current && event.propertyName === 'transform') setAdvancing(false);
          }}
        >
          {picks.map(({ index, pick }) => {
            const thread = DRAFT_THREADS[pick.thread]!;
            return (
              <li key={index} className="pick" style={{ '--thread': thread.color } as CSSProperties}>
                <span className="pick__weft" aria-hidden="true">
                  {DRAFT_THREADS.map((warp, column) => (
                    <i
                      key={warp.name}
                      className={`cross ${(index + column) % 2 === 0 ? 'is-warp' : ''}`}
                      style={{ '--warp': warp.color } as CSSProperties}
                    />
                  ))}
                </span>
                <span className="pick__note"><b>{thread.name}</b>{pick.text}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </figure>
  );
}

/** A static swatch: three continuous warps, eight weft passes, plain weave. */
function WeaveSwatch(): ReactNode {
  const warps = [THREAD_COLORS[2]!.hex, THREAD_COLORS[5]!.hex, THREAD_COLORS[6]!.hex];
  const wefts = ['#F3EEE3', THREAD_COLORS[1]!.hex, '#F3EEE3', THREAD_COLORS[3]!.hex, '#F3EEE3', THREAD_COLORS[0]!.hex, '#F3EEE3', THREAD_COLORS[4]!.hex];
  return (
    <div className="swatch" role="img" aria-label="A woven swatch of three coloured threads">
      <div className="swatch__cloth">
        <span className="swatch__warps" aria-hidden="true">
          {warps.map((warp, column) => <i key={column} style={{ '--warp': warp } as CSSProperties} />)}
        </span>
        {wefts.map((weft, row) => (
          <span key={row} className="swatch__row" style={{ '--thread': weft } as CSSProperties}>
            {warps.map((warp, column) => (
              <i key={column} className={(row + column) % 2 === 0 ? 'is-warp' : ''} style={{ '--warp': warp } as CSSProperties} />
            ))}
          </span>
        ))}
      </div>
    </div>
  );
}

function WovenChip({ colors, empty = false }: { colors: [string, string]; empty?: boolean }): ReactNode {
  return (
    <span className={`chip ${empty ? 'chip--empty' : ''}`} aria-hidden="true" style={{ '--a': colors[0], '--b': colors[1] } as CSSProperties} />
  );
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matchReducedMotion());
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (): void => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

function matchReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
