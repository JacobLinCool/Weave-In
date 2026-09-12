import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { Bot, Mic, Send, Square, Volume2 } from 'lucide-react';
import { parseAgentConfig, type AgentConfig, type AgentKind } from './contracts';
import { AgentRuntime } from './runtime';
import { defaultAgentConfig } from './config';
export { defaultAgentConfig } from './config';
import './style.css';

export function AgentPanel({ runtime, isHost, mode = 'all' }: { runtime: AgentRuntime; isHost: boolean; mode?: 'personal' | 'group' | 'all' }): ReactNode {
  const view = useSyncExternalStore(runtime.subscribe, runtime.snapshot);
  const [expanded, setExpanded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<void>) => { setError(null); void action().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Please try again.')); };
  const group = view.group;
  const submit = (event: FormEvent) => { event.preventDefault(); if (!text.trim()) return; const value = text; run(async () => { await runtime.ask(value); setText((current) => current === value ? '' : current); }); };
  return <div className={`agent-panel${expanded ? ' agent-panel--expanded' : ''}`}>
    <header className="agent-panel__heading"><h2><Bot size={20} /> {mode === 'personal' ? 'Chat' : mode === 'group' ? 'Omni' : 'Assistants'}</h2><button className="agent-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Collapse panel' : 'Expand panel'}</button></header>
    {!view.ready && <button className="agent-action" onClick={() => run(() => runtime.enable())}><Volume2 size={16} /> Enable assistant audio on this device</button>}
    {(error || view.error) && <p className="agent-error" role="alert">{error ?? view.error}</p>}
    {mode !== 'personal' && <section className="agent-group" aria-label="Group assistant">
      <h3>{group?.config.name ?? 'Omni'}</h3>
      {group ? <>
        <p role="status">{({ idle: 'Listening to public meeting context', preparing: 'Preparing a text suggestion', raised: 'Sharing a text suggestion', speaking: 'Sharing a text suggestion', waiting: 'Waiting for an available device' })[group.phase]}</p>
        {group.epoch > 1 && <p className="agent-note">Recovered on another device. Earlier meeting history may be incomplete.</p>}
        <div className="agent-actions">
          <button onClick={() => runtime.command({ type: 'agent-signal', id: group.id })}>Trigger review</button>

          {group.phase !== 'idle' && <button onClick={() => runtime.command({ type: 'agent-cancel', id: group.id })}><Square size={14} /> Stop</button>}
          {(isHost || group.owner === runtime.ctx.peerId) && <button onClick={() => runtime.remove(group.id)}>Remove</button>}
        </div>

      </> : <p>Public text suggestions for this meeting.</p>}
    </section>}
    {((mode !== 'group' && !view.personal) || (mode !== 'personal' && !group)) && !creating && <button className="agent-action" onClick={() => setCreating(true)}>Create an assistant</button>}
    {creating && <AgentForm personalAvailable={mode !== 'group' && !view.personal} groupAvailable={mode !== 'personal' && !group} onCancel={() => setCreating(false)} onCreate={async (config) => { await runtime.create(config); setCreating(false); }} />}
    {mode !== 'group' && view.personal && <section className="agent-personal" aria-label="Personal assistant">
      <div className="agent-actions"><h3>{view.personal.config.name}</h3><button onClick={() => runtime.remove(view.personal!.id)}>Remove</button></div>
      <details><summary>Information sources and permissions</summary><ConfigSummary config={view.personal.config} /><p className="agent-note">To change sources or permissions, remove this assistant and create a new one.</p></details>
      <div className="agent-conversation" role="log" aria-label="Personal assistant transcript" tabIndex={0}>
        {view.lines.length === 0 && <p className="agent-note">Ask about the discussion or a shared file. Try “Turn the discussion into a flowchart on the whiteboard” or “Post the agreed next steps in Room chat.”</p>}
        {view.lines.map((line) => <article key={line.id} className="agent-line"><strong>{line.name}</strong><span>{line.audience} · {line.input}{line.role === 'assistant' ? ` · ${line.playback}` : ''}</span><p>{line.text}</p></article>)}
      </div>
      <p className="agent-note" role="status">{view.status}{view.queued > 0 ? ` ${view.queued} request(s) queued.` : ''}</p>
      <p className="agent-note">Replies stay private. Ask explicitly to edit the shared whiteboard or post in Room chat.</p>
      <form onSubmit={submit} className="agent-compose"><label className="agent-field">Message Chat<textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={4000} rows={3} placeholder="Turn the discussion into a flowchart on the whiteboard…" /></label><div className="agent-actions"><button className="agent-action" type="submit" disabled={!text.trim()}><Send size={15} /> Send</button><button type="button" onClick={() => view.voice ? runtime.endVoice() : run(() => runtime.ask('', true))}><Mic size={15} /> {view.voice ? 'Finish speaking' : 'Talk to Chat'}</button><button type="button" onClick={() => runtime.stopPersonal()}>Stop</button></div></form>
    </section>}
  </div>;
}

function AgentForm({ personalAvailable, groupAvailable, onCreate, onCancel }: { personalAvailable: boolean; groupAvailable: boolean; onCreate(config: AgentConfig): Promise<void>; onCancel(): void }): ReactNode {
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
  return <form className="agent-form" onSubmit={(event) => void submit(event)}>
    <h3>Create an assistant</h3>
    {error && <p role="alert" className="agent-error">{error}</p>}
    <fieldset disabled={busy}><legend>Type and role</legend>
      <label className="agent-field">Type<select value={config.kind} onChange={(event) => { setConfig(defaultAgentConfig(event.target.value as AgentKind)); setReview(false); }}><option value="personal" disabled={!personalAvailable}>Personal — your own assistant</option><option value="group" disabled={!groupAvailable}>Group — one for the meeting</option></select></label>
      <label className="agent-field">Display name<input required maxLength={40} value={config.name} onChange={(event) => set('name', event.target.value)} /></label>
      <label className="agent-field">Role and task instructions (Markdown)<textarea required rows={6} maxLength={8000} value={config.instructions} onChange={(event) => set('instructions', event.target.value)} /></label>
      <label className="agent-field">Response language<input required maxLength={80} value={config.language} onChange={(event) => set('language', event.target.value)} aria-describedby="agent-language-help" /></label><p id="agent-language-help" className="agent-note">Use “auto” to follow the conversation, or name a language.</p>
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
      {config.kind === 'personal' && <p className="agent-note">Chat can read the shared whiteboard during a private request. It can edit the board or post in Room chat when you ask. Shared files and images are read as needed; unavailable files cannot be inspected.</p>}
      <p>{config.kind === 'personal' ? 'Spoken replies stay private. Speak for me approves one public spoken turn about a selected reminder.' : 'Public text suggestions only. Omni does not speak aloud.'}</p>
      <p className="agent-note">Voice and text are recorded in the transcript for the selected audience. Instructions cannot override permissions.</p>
    </fieldset>
    {review && <div className="agent-review"><h4>Review before creating</h4><ConfigSummary config={parseAgentConfig(config)!} /></div>}
    <div className="agent-actions"><button className="agent-action" type="submit" disabled={busy}>{busy ? 'Creating…' : review ? 'Create assistant' : 'Review settings'}</button><button type="button" onClick={onCancel} disabled={busy}>Cancel</button></div>
  </form>;
}
function ConfigSummary({ config }: { config: AgentConfig }): ReactNode {
  return <dl className="agent-summary"><dt>Type</dt><dd>{config.kind}</dd><dt>Name</dt><dd>{config.name}</dd><dt>Language</dt><dd>{config.language}</dd><dt>Meeting sources</dt><dd>{config.source}</dd><dt>Public chat</dt><dd>{config.chat ? 'Included' : 'Excluded'}</dd><dt>System signals</dt><dd>{config.system ? 'Included' : 'Excluded'}</dd><dt>Shared screen</dt><dd>{config.screen ? 'Allowed' : 'Not allowed'}</dd><dt>Shared files and images</dt><dd>{config.files ? 'Allowed' : 'Not allowed'}</dd>{config.kind === 'personal' && <><dt>Shared whiteboard</dt><dd>Read during private requests; edit when asked</dd><dt>Room messages</dt><dd>Post when asked</dd></>}<dt>Audience</dt><dd>{config.audience}</dd></dl>;
}
