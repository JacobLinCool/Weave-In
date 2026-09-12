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
  { thread: 2, text: 'Can we ship the new flow on Friday?' },
  { thread: 0, text: 'The happy path looks ready.' },
  { thread: 4, text: 'I have a concern about failed payments.' },
  { thread: 1, text: 'Let’s look at that before we decide.' },
  { thread: 4, text: 'I worked through the edge case with Muse.' },
  { thread: 3, text: 'Codex added the retry path to our board.' },
  { thread: 2, text: 'I’ll move the review step before launch.' },
  { thread: 0, text: 'Now we can check both paths together.' },
  { thread: 1, text: 'Omni caught the open question in our agenda.' },
  { thread: 4, text: 'Let’s resolve it before we commit.' },
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
          <a href="#agents">Meet the agents</a>
          <a href="#whiteboard">Shared thinking</a>
          <a href="#data">Privacy</a>
          <button className="icon-button icon-button--wide" type="button" onClick={props.onOpenSettings} aria-label="Settings">
            <Settings size={16} /><span>Settings</span>
          </button>
        </nav>
      </header>

      <section className={`hero ${props.invitedRoom ? 'hero--invited' : ''}`} aria-labelledby="hero-title">
        <div className="hero__copy">
          <h1 id="hero-title">Keep the thread. <br />Weave everyone in.</h1>
          <p className="hero__lede">An agent-native meeting app for thinking independently and contributing together. Give every idea a way into the conversation—with private voice support, Codex, and a shared whiteboard.</p>
          <a className="landing-text-link" href="#agents">See how the agents work together <ArrowRight size={16} /></a>
        </div>
        <WeaveDraft />
        <RoomPanel {...props} />
      </section>

      <section className="sheet" aria-labelledby="thinking-title">
        <div className="sheet__head">
          <h2 id="thinking-title">Good ideas don’t always get a turn.</h2>
          <p>Keep critical thinking in the conversation, while it can still shape the decision.</p>
        </div>
        <div className="landing-prose">
          <p>A proposal lands. Everyone agrees before the doubts are heard. That’s the groupthink risk we care about.</p>
          <p>Or the conversation moves so quickly that someone waits to speak—and loses their thought along the way.</p>
          <p>Weave In gives those ideas a place to be captured, worked through, and brought back to the room. Right inside the meeting, before the decision is made.</p>
        </div>
      </section>

      <section id="agents" className="sheet" aria-labelledby="agents-title">
        <div className="sheet__head">
          <h2 id="agents-title">Three agents.<br />Room for your way of thinking.</h2>
          <p>Shared focus, private conversation, and work that moves forward alongside the meeting.</p>
        </div>
        <div className="agent-roles">
          <article className="agent-role">
            <div className="agent-role__title"><h3>Omni</h3><span>For the whole room</span></div>
            <p>Bring an unanswered concern back into view, or return to an explicit meeting goal. Omni prepares a question silently and speaks after someone approves. Your team decides where to go next.</p>
          </article>
          <article className="agent-role">
            <div className="agent-role__title"><h3>Muse</h3><span>For thinking out loud, privately</span></div>
            <p>Talk through a half-formed idea or ask about a shared screen without interrupting the room. Powered by GPT-Live-1, Muse gives you a real-time voice side chat. You choose what to share.</p>
          </article>
          <article className="agent-role">
            <div className="agent-role__title"><h3>Codex</h3><span>For work that takes a little longer</span></div>
            <p>Bring the personal agent you already use. Ask it to check code, research a question, compare approaches, or build a diagram while the conversation continues. Share the result when it’s ready.</p>
          </article>
        </div>
      </section>

      <section id="codex" className="sheet" aria-labelledby="codex-title">
        <div className="sheet__head">
          <h2 id="codex-title">Your meeting.<br />Inside your agent’s browser.</h2>
          <p>Weave In works in a regular browser. In the Codex built-in browser, your agent can work directly with the room.</p>
        </div>
        <div className="landing-prose">
          <p>WebMCP gives Codex structured tools to read the live transcript, public chat, shared screen, and whiteboard within the access you allow.</p>
          <p>Ask it to investigate a question, then post its findings to chat or update the board. The context comes from the meeting. The work comes back to everyone.</p>
          <div className="context-flow" aria-label="Meeting context flows through WebMCP to Codex, which returns findings and edits to the room">
            <span>Meeting context</span><ArrowRight size={18} aria-hidden="true" /><strong>WebMCP</strong><ArrowRight size={18} aria-hidden="true" /><span>Codex</span>
          </div>
          <p className="context-flow__return">Findings to chat. Editable diagrams to the board.</p>
        </div>
      </section>

      <section id="whiteboard" className="sheet sheet--board" aria-labelledby="board-title">
        <div className="sheet__head">
          <h2 id="board-title">One board.<br />Everyone can build on it.</h2>
          <p>Keep a process, an architecture, or an open question in view. Point to it, challenge it, change it—together.</p>
          <p>We keep the whiteboard inside our meeting environment so people and agents can work on the same thing. Through structured tools, Codex reads the actual nodes, labels, and connections, then edits specific elements.</p>
          <p>Supported Mermaid diagrams become editable whiteboard elements. You adjust them visually. Your agent reads the updated structure and picks up where you left off.</p>
        </div>
        <WhiteboardDemo />
      </section>

      <section className="sheet" aria-labelledby="together-title">
        <div className="sheet__head">
          <h2 id="together-title">From a quiet concern<br />to a better discussion.</h2>
          <p>A feature review, with space for everyone’s contribution.</p>
        </div>
        <ol className="collaboration-path">
          <li><strong>Work it through with Muse.</strong><p>You spot a payment edge case. A private conversation helps you turn the concern into a clear question.</p></li>
          <li><strong>Give Codex the investigation.</strong><p>It checks the implementation and, at your request, shares its findings and a flowchart with the room.</p></li>
          <li><strong>Refine the answer together.</strong><p>The team edits the board. Omni brings the open agenda question back before everyone commits.</p></li>
        </ol>
      </section>

      <section id="data" className="sheet sheet--key" aria-labelledby="data-title">
        <div className="sheet__head">
          <h2 id="data-title">Where your data goes</h2>
          <p>Clear boundaries for a shared room and your private thinking.</p>
        </div>
        <dl className="key">
          <div className="key__row">
            <dt><WovenChip colors={[THREAD_COLORS[1]!.hex, THREAD_COLORS[3]!.hex]} /> Between participants</dt>
            <dd>Video, voice, screen share, chat, files, whiteboard edits, and captions travel over encrypted WebRTC connections between participants. Connections use a direct path when possible; Cloudflare TURN can relay encrypted packets when the network requires it. The relay handles connection metadata such as IP addresses and timing, but cannot read the encrypted content.</dd>
          </div>
          <div className="key__row">
            <dt><WovenChip colors={[THREAD_COLORS[0]!.hex, '#F3EEE3']} /> To AI providers</dt>
            <dd>Your microphone goes directly to your caption provider. Your browser sends permitted assistant context, conversation and tool results directly to the configured AI provider; private assistant conversations stay out of the public room.</dd>
          </div>
          <div className="key__row">
            <dt><WovenChip colors={['#303A6B', '#F3EEE3']} /> Our server</dt>
            <dd>Our signaling Worker connects browsers, issues short-lived caption and TURN credentials, and initializes assistants. The room service stores assistant settings and coordination state. Meeting media and shared content use the participant connections; Cloudflare's TURN relay is a separate path. Automatic reminders send recent transcript text and previous reminder evidence through the Worker to an AI provider. The server does not store that analysis or private conversations. Analysis starts automatically; there is currently no pause switch.</dd>
          </div>
          <div className="key__row">
            <dt><WovenChip colors={[THREAD_COLORS[2]!.hex, '#F3EEE3']} /> In this browser</dt>
            <dd>Your display name and caption preferences stay in local browser storage. A bounded checkpoint in this tab keeps text chat, transcripts, reminders, and private Muse conversation for refresh or rejoin, valid for 12 hours after the last save. Leaving keeps that checkpoint. File bytes and the whiteboard stay in memory, so export before everyone leaves. AI-provider retention is separate from this browser storage.</dd>
          </div>
        </dl>
      </section>

      <section className="close" aria-label="Start">
        <WeaveMark size={44} />
        <h2>Bring your next idea.</h2>
        <p>Video, screen sharing, live captions, and a shared board. Up to eight people. One link. No account needed.</p>
        <a className="primary-button primary-button--large close__cta" href="#start">Create a room <ArrowRight size={18} /></a>
      </section>
      <footer className="landing__footer">
        <Brand compact />
        <button className="landing__footer-link" type="button" onClick={props.onOpenSettings}>Caption languages and style</button>
      </footer>
    </main>
  );
}

function WhiteboardDemo(): ReactNode {
  const [refined, setRefined] = useState(false);
  return (
    <figure className="board-demo">
      <div className="board-demo__controls" aria-label="Whiteboard example states">
        <button type="button" aria-pressed={!refined} onClick={() => setRefined(false)}>Codex draws</button>
        <button type="button" aria-pressed={refined} onClick={() => setRefined(true)}>You refine</button>
      </div>
      <svg className="board-demo__canvas" viewBox="0 0 560 320" role="img" aria-label={refined ? 'Payment flow with a human-added review step before retrying' : 'Payment flow generated by Codex with a retry path'}>
        <defs><marker id="board-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
        <g className="board-demo__edges" fill="none" stroke="currentColor" strokeWidth="2" markerEnd="url(#board-arrow)">
          <path d="M 142 88 H 223" /><path d="M 337 88 H 418" />
          <path d="M 280 120 V 218" /><path d="M 226 246 H 86 V 118" />
        </g>
        <g className="board-demo__nodes">
          <rect x="30" y="58" width="112" height="60" rx="8" /><rect x="224" y="58" width="112" height="60" rx="8" /><rect x="418" y="58" width="112" height="60" rx="8" />
          <rect className={refined ? 'is-refined' : ''} x="206" y="218" width="148" height="60" rx="8" />
        </g>
        <g className="board-demo__labels" textAnchor="middle"><text x="86" y="94">Payment</text><text x="280" y="94">Check result</text><text x="474" y="94">Confirm</text><text x="280" y="254">{refined ? 'Review, then retry' : 'Retry'}</text></g>
        <g className="board-demo__annotations"><text x="366" y="75">Success</text><text x="296" y="173">Failed</text><text x="40" y="302">{refined ? 'Edited by you · ready for Codex to read' : 'Mermaid → editable nodes and connections'}</text></g>
      </svg>
      <figcaption><strong>Illustrative workflow</strong><span>{refined ? 'Your edit stays structured. Codex can continue from this version.' : 'Codex creates the structure. Select “You refine” to see a human edit.'}</span></figcaption>
    </figure>
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
      <figcaption className="draft__caption">Illustrative conversation · every voice has a thread</figcaption>
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
