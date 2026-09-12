import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Mic, Send, Square, Maximize2, Minimize2, X } from 'lucide-react';
import { parseAgentConfig, type AgentConfig, type AgentKind } from './contracts';
import { AgentRuntime } from './runtime';
import { defaultAgentConfig } from './config';
export { defaultAgentConfig } from './config';
import './style.css';

export function AgentPanel({ runtime, isHost, mode = 'all', reminders }: { runtime: AgentRuntime; isHost: boolean; mode?: 'personal' | 'group' | 'all'; reminders?: ReactNode }): ReactNode {
  const view = useSyncExternalStore(runtime.subscribe, runtime.snapshot);
  const [expanded, setExpanded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<void>) => { setError(null); void action().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Please try again.')); };
  const group = view.group;
  const submit = (event: FormEvent) => { event.preventDefault(); if (!text.trim()) return; const value = text; run(async () => { await runtime.ask(value); setText((current) => current === value ? '' : current); }); };
  const setup = creating && <AgentForm personalAvailable={mode !== 'group' && !view.personal} groupAvailable={mode !== 'personal' && !group} onCancel={() => setCreating(false)} onCreate={async (config) => { await runtime.create(config); setCreating(false); }} />;
  if (mode === 'group') return <section className="agent-panel agent-panel--group" aria-label="Omni public suggestions">
    <div className="omni-bar">
      <Bot size={18} aria-hidden="true" />
      <div className="omni-bar__label"><h2>{group?.config.name ?? 'Omni'}</h2><p role="status">{group ? ({ idle: 'Public · Ready', preparing: 'Preparing a suggestion…', raised: 'Sharing a suggestion…', speaking: 'Sharing a suggestion…', waiting: 'Waiting for an available device' })[group.phase] : 'Public suggestions'}</p></div>
      {group ? <div className="agent-actions">
        {group.phase === 'idle' ? <button type="button" onClick={() => runtime.command({ type: 'agent-signal', id: group.id })}>Review now</button> : <button type="button" onClick={() => runtime.command({ type: 'agent-cancel', id: group.id })}><Square size={14} /> Stop</button>}
        <button type="button" onClick={() => setManaging(true)}>Settings</button>
      </div> : <button type="button" onClick={() => setCreating(true)}>Set up Omni</button>}
    </div>
    {(error || view.error) && <p className="agent-error" role="alert">{error ?? view.error}</p>}
    {setup}
    {managing && group && <AgentDialog title={`${group.config.name} settings`} onClose={() => setManaging(false)}>
      <p className="agent-note">Public text suggestions appear in Room. Private conversations are never included.</p>
      <ConfigSummary config={group.config} />
      {group.epoch > 1 && <p className="agent-note">Recovered on another device. Earlier meeting history may be incomplete.</p>}
      {(isHost || group.owner === runtime.ctx.peerId) && <button type="button" onClick={() => { runtime.remove(group.id); setManaging(false); }}>Remove assistant</button>}
    </AgentDialog>}
  </section>;
  return <div className={`agent-panel agent-panel--personal${expanded ? ' agent-panel--expanded' : ''}`}>
    <header className="agent-panel__heading">
      <div><h2><Bot size={18} aria-hidden="true" /> {view.personal?.config.name ?? 'Muse'}</h2><p>Only you</p></div>
      <div className="agent-actions">
        {view.personal && <button type="button" onClick={() => setManaging(true)}>Settings</button>}
        <button type="button" className="agent-expand" aria-label={expanded ? 'Narrow panel' : 'Widen panel'} title={expanded ? 'Narrow panel' : 'Widen panel'} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
      </div>
    </header>
    {reminders}
    {mode === 'all' && <AgentPanel runtime={runtime} mode="group" isHost={isHost} />}
    {(error || view.error) && <p className="agent-error" role="alert">{error ?? view.error}</p>}
    {!view.personal && <div className="agent-empty"><p>Set up your private assistant to start a conversation.</p><button className="agent-action" onClick={() => setCreating(true)}>Create an assistant</button></div>}
    {setup}
    {managing && view.personal && <AgentDialog title={`${view.personal.config.name} settings`} onClose={() => setManaging(false)}>
      {!view.ready && <button type="button" onClick={() => run(() => runtime.enable())}>Enable assistant audio</button>}
      <ConfigSummary config={view.personal.config} />
      <p className="agent-note">Spoken replies stay private. Ask explicitly to edit the shared whiteboard. {view.personal.config.roomMessages ? 'Room posting is allowed when you request a public message.' : 'Room posting is off. Enable “Allow posting to Room” when creating an assistant to allow public messages.'}</p>
      <p className="agent-note">To change sources or permissions, remove this assistant and create a new one. Removing it clears this tab’s private conversation.</p>
      <button type="button" onClick={() => { runtime.remove(view.personal!.id); setManaging(false); }}>Remove assistant</button>
    </AgentDialog>}
    {view.personal && <section className="agent-personal" aria-label="Personal assistant">
      <div className="agent-conversation" role="log" aria-label="Personal assistant transcript" tabIndex={0}>
        {view.lines.length === 0 && <div className="agent-empty"><p>Ask about the discussion or a shared file. Try “Draw our workflow on the whiteboard.”</p></div>}
        {view.lines.map((line) => <article key={line.id} className={`agent-line${line.role === 'user' ? ' agent-line--own' : ''}`}><strong>{line.role === 'user' ? 'You' : line.name}</strong><p>{line.text}</p></article>)}
      </div>
      <form onSubmit={submit} className="agent-compose">
        <p className="agent-note" role="status">{view.status}{view.queued > 0 ? ` ${view.queued} request(s) queued.` : ''}</p>
        <label className="agent-field"><span className="visually-hidden">Message {view.personal.config.name}</span><textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={4000} rows={2} placeholder="Message privately…" /></label>
        <div className="agent-actions"><button className="agent-action" type="submit" disabled={!text.trim()}><Send size={15} /> Send</button><button type="button" onClick={() => view.voice ? runtime.endVoice() : run(() => runtime.ask('', true))}><Mic size={15} /> {view.voice ? 'Finish speaking' : 'Talk'}</button>{view.working && <button type="button" onClick={() => runtime.stopPersonal()}><Square size={14} /> Stop</button>}</div>
      </form>
    </section>}
  </div>;
}

function AgentForm({ personalAvailable, groupAvailable, onCreate, onCancel }: { personalAvailable: boolean; groupAvailable: boolean; onCreate(config: AgentConfig): Promise<void>; onCancel(): void }): ReactNode {
  const languageHelp = useId();
  const [config, setConfig] = useState(() => defaultAgentConfig(personalAvailable ? 'personal' : 'group'));
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) => { setConfig((current) => ({ ...current, [key]: value })); setReview(false); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); const parsed = parseAgentConfig(config);
    if (!parsed) { setError('Complete the name, instructions, and language.'); return; }
    if (!review) { setReview(true); return; }
    setBusy(true); setError(null);
    try { await onCreate(parsed); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to create the assistant.'); } finally { setBusy(false); }
  };
  return <AgentDialog title={personalAvailable ? 'Create an assistant' : 'Set up Omni'} onClose={onCancel} busy={busy}><form className="agent-form" onSubmit={(event) => void submit(event)}>
    {error && <p role="alert" className="agent-error">{error}</p>}
    <fieldset disabled={busy}><legend>Type and role</legend>
      {personalAvailable && groupAvailable && <label className="agent-field">Type<select value={config.kind} onChange={(event) => { setConfig(defaultAgentConfig(event.target.value as AgentKind)); setReview(false); }}><option value="personal" disabled={!personalAvailable}>Personal — your own assistant</option><option value="group" disabled={!groupAvailable}>Group — one for the meeting</option></select></label>}
      <label className="agent-field">Display name<input required maxLength={40} value={config.name} onChange={(event) => set('name', event.target.value)} /></label>
      <label className="agent-field">Role and task instructions (Markdown)<textarea required rows={6} maxLength={8000} value={config.instructions} onChange={(event) => set('instructions', event.target.value)} /></label>
      <label className="agent-field">Response language<input required maxLength={80} value={config.language} onChange={(event) => set('language', event.target.value)} aria-describedby={languageHelp} /></label><p id={languageHelp} className="agent-note">Use “auto” to follow the conversation, or name a language.</p>
    </fieldset>
    <fieldset disabled={busy}><legend>Information sources</legend>
      {config.kind === 'personal' ? <>
        <label className="agent-field">Public meeting sources<select value={config.source} onChange={(event) => set('source', event.target.value as AgentConfig['source'])}><option value="none">None — only my direct requests</option><option value="owner">Only my public contributions</option><option value="all">Everyone’s public contributions</option></select></label>
        <label className="agent-check"><input type="checkbox" checked={config.chat && config.source !== 'none'} disabled={config.source === 'none'} onChange={(event) => set('chat', event.target.checked)} /> Include public chat from these sources</label>
        <label className="agent-check"><input type="checkbox" checked={config.system} onChange={(event) => set('system', event.target.checked)} /> Receive system signals as background context</label>
        <p className="agent-note">Your direct text and voice requests are always included. Background updates do not trigger a reply.</p>
      </> : <p>Receives all public meeting transcripts, public chat, and system signals. Personal conversations are never included.</p>}
    </fieldset>
    <fieldset disabled={busy}><legend>Tools and output</legend>
      <label className="agent-check"><input type="checkbox" checked={config.screen} onChange={(event) => set('screen', event.target.checked)} /> Allow viewing the shared screen</label>
      <label className="agent-check"><input type="checkbox" checked={config.files} onChange={(event) => set('files', event.target.checked)} /> Allow reading shared files and images</label>
      {config.kind === 'personal' && <label className="agent-check"><input type="checkbox" checked={config.roomMessages === true} onChange={(event) => set('roomMessages', event.target.checked)} /> Allow posting to Room (visible to everyone)</label>}
      {config.kind === 'personal' && <p className="agent-note">Muse can read the shared whiteboard during a private request and edit it when you ask. Room posting is disabled unless you allow it above, then request a public message. Shared files and images are read as needed; unavailable files cannot be inspected.</p>}
      <p>{config.kind === 'personal' ? 'Spoken replies stay private. Speak for me approves one public spoken turn about a selected reminder.' : 'Public text suggestions only. Omni does not speak aloud.'}</p>
      <p className="agent-note">Voice and text are recorded in the transcript for the selected audience. Instructions cannot override permissions.</p>
    </fieldset>
    {review && <div className="agent-review"><h4>Review before creating</h4><ConfigSummary config={parseAgentConfig(config)!} /></div>}
    <div className="agent-actions"><button className="agent-action" type="submit" disabled={busy}>{busy ? 'Creating…' : review ? 'Create assistant' : 'Review settings'}</button><button type="button" onClick={onCancel} disabled={busy}>Cancel</button></div>
  </form></AgentDialog>;
}
function AgentDialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose(): void; busy?: boolean }): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return createPortal(<dialog ref={ref} className="agent-dialog agent-panel" aria-labelledby={heading} aria-busy={busy} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="agent-dialog__heading"><h2 id={heading}>{title}</h2><button type="button" onClick={onClose} disabled={busy} aria-label="Close assistant settings"><X size={18} /></button></header>
    {children}
  </dialog>, document.body);
}

function ConfigSummary({ config }: { config: AgentConfig }): ReactNode {
  return <dl className="agent-summary"><dt>Type</dt><dd>{config.kind}</dd><dt>Name</dt><dd>{config.name}</dd><dt>Language</dt><dd>{config.language}</dd><dt>Meeting sources</dt><dd>{config.source}</dd><dt>Public chat</dt><dd>{config.chat ? 'Included' : 'Excluded'}</dd><dt>System signals</dt><dd>{config.system ? 'Included' : 'Excluded'}</dd><dt>Shared screen</dt><dd>{config.screen ? 'Allowed' : 'Not allowed'}</dd><dt>Shared files and images</dt><dd>{config.files ? 'Allowed' : 'Not allowed'}</dd>{config.kind === 'personal' && <><dt>Shared whiteboard</dt><dd>Read during private requests; edit when asked</dd><dt>Room messages</dt><dd>{config.roomMessages ? 'Allowed when you request a public message' : 'Disabled — private replies only'}</dd></>}<dt>Audience</dt><dd>{config.audience}</dd></dl>;
}
