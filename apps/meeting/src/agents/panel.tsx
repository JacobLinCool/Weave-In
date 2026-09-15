import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowUp, AudioLines, LoaderCircle, LockKeyhole, Mic, Plus, Send, Settings, Square, Trash2, Volume2 } from 'lucide-react';
import { parseAgentConfig, type AgentConfig, type AgentKind } from './contracts';
import { AgentRuntime } from './runtime';
import { defaultAgentConfig } from './config';
export { defaultAgentConfig } from './config';
import { Markdown } from '../markdown';
import { Dictation } from './dictation';
import './style.css';

export function AgentPanel({ runtime, isHost, mode = 'personal' }: { runtime: AgentRuntime; isHost: boolean; mode?: 'personal' | 'group' }): ReactNode {
  const view = useSyncExternalStore(runtime.subscribe, runtime.snapshot);
  const dictation = useMemo(() => new Dictation(runtime.ctx), [runtime]);
  const dictated = useSyncExternalStore(dictation.subscribe, dictation.snapshot);
  const draftPrefix = useRef('');
  const dictating = dictated.status !== 'idle';
  const dictationBusy = dictated.status === 'starting' || dictated.status === 'stopping';
  const conversation = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [sending, setSending] = useState(false);
  const [startingLive, setStartingLive] = useState(false);
  const liveStartVersion = useRef(0);
  const liveSession = startingLive || view.voice;
  const previousLiveSession = useRef(false);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const endLiveControl = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (liveSession !== previousLiveSession.current) {
      (liveSession ? endLiveControl.current : composerInput.current)?.focus();
      previousLiveSession.current = liveSession;
    }
  }, [liveSession]);
  const [tooltipDismissed, setTooltipDismissed] = useState(false);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') setTooltipDismissed(true); };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, []);
  const responding = !dictating && (sending || view.personalActive);
  const [addingGroup, setAddingGroup] = useState(false);
  const [creating, setCreating] = useState<AgentKind | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<void>) => { setError(null); void action().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Please try again.')); };
  useEffect(() => () => { void dictation.cancel(); }, [dictation]);
  useEffect(() => { if (dictated.text) setText([draftPrefix.current, dictated.text].filter(Boolean).join(' ')); }, [dictated.text]);
  const group = view.group;
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (panel.current) panel.current.scrollTop = 0; }, [creating, editing]);
  useLayoutEffect(() => {
    if (conversation.current && followLatest.current) conversation.current.scrollTop = conversation.current.scrollHeight;
  }, [view.lines]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (sending || liveSession || view.personalActive || dictationBusy || (!dictating && !text.trim())) return;
    setSending(true);
    followLatest.current = true;
    run(async () => {
      try {
        const value = dictating ? [draftPrefix.current, await dictation.stop()].filter(Boolean).join(' ') : text;
        setText(value);
        if (!value.trim()) return;
        if (value.length > 4000) throw new Error('Keep the message under 4,000 characters.');
        await runtime.ask(value);
        setText((current) => current === value ? '' : current);
      } finally { setSending(false); }
    });
  };
  return <div ref={panel} className={`agent-panel${mode === 'personal' ? ' agent-panel--personal' : ` agent-panel--group${group?.phase === 'raised' && !view.room.approval ? ' agent-panel--active' : ''}`}`}>
    {!editing && !view.ready && mode === 'group' && group && <button onClick={() => run(() => runtime.enable())}><Volume2 size={16} /> Enable assistant audio on this device</button>}
    {(error || view.error || dictated.error) && <p className="agent-error" role="alert">{error ?? view.error ?? dictated.error}</p>}
    {!creating && !editing && mode !== 'personal' && <section className="agent-group" aria-label="Omni">
      <header className="agent-actions"><h3>Omni</h3>{group ? <><button className="agent-icon-button" aria-label="Omni settings" title="Omni settings" onClick={() => { setEditing(group.id); setCreating(null); }}><Settings size={20} /></button>{(isHost || group.owner === runtime.ctx.peerId) && <button className="agent-icon-button" aria-label="Remove Omni" title="Remove Omni" onClick={() => runtime.remove(group.id)}><Trash2 size={20} /></button>}</> : <button className="agent-action agent-add agent-icon-button" aria-label={addingGroup ? 'Adding Omni' : 'Add Omni'} title="Add Omni" disabled={addingGroup} onClick={() => {
        setAddingGroup(true);
        run(async () => { try { await runtime.create(defaultAgentConfig('group')); } finally { setAddingGroup(false); } });
      }}><Plus size={18} aria-hidden="true" /></button>}</header>
      {group?.phase === 'idle' && <p role="status">{view.groupStatus}</p>}
      {group && group.phase !== 'idle' && <>
        <p role="status">{({ preparing: 'Analyzing public discussion…', raised: view.room.approval ? 'Approved · waiting for a quiet moment' : 'Omni is ready. Allow it to speak to the room.', speaking: 'Speaking to everyone', waiting: 'Waiting for an available device' })[group.phase]}</p>
        {group.phase === 'raised' && !view.room.approval && <>
          <button type="button" className="agent-action" onClick={() => runtime.approveGroup()}><Volume2 size={16} aria-hidden="true" /> Allow Omni to speak</button>
          <p className="agent-note">Or say “Omni, go ahead” / “Omni，請發言” with captions enabled.</p>
        </>}
        <button onClick={() => runtime.command({ type: 'agent-cancel', id: group.id })}><Square size={14} /> Stop</button>
      </>}
    </section>}
    {!creating && !editing && mode !== 'group' && !view.personal && <section className="agent-personal" aria-label="Muse">
      <h3>Muse</h3><p className="agent-note">Not added. A private assistant for your questions and ideas.</p>
      {!creating && <button className="agent-action agent-add agent-icon-button" aria-label="Add Muse" title="Add Muse" onClick={() => { setCreating('personal'); setEditing(null); }}><Plus size={20} aria-hidden="true" /></button>}
    </section>}
    {creating && <AgentForm key={creating} initialConfig={defaultAgentConfig(creating)} onCancel={() => setCreating(null)} onSave={async (config) => { await runtime.create(config); setCreating(null); }} />}
    {!creating && !editing && mode !== 'group' && view.personal && <section className="agent-personal" aria-label="Muse">
      <header className="agent-personal__heading"><div className="agent-actions"><div><h2>Muse</h2><p><LockKeyhole size={12} aria-hidden="true" /> Private conversation</p></div><button className="agent-icon-button" aria-label="Muse settings" title={liveSession ? 'End Live to change settings' : 'Muse settings'} disabled={dictating || liveSession} onClick={() => setEditing(view.personal!.id)}><Settings size={20} aria-hidden="true" /></button></div></header>
      <div ref={conversation} className="agent-conversation" role="log" aria-label="Muse transcript" tabIndex={0} onScroll={(event) => {
        const node = event.currentTarget;
        followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
      }}>
        {view.lines.length === 0 && <div className="agent-empty"><h3>A little space to think.</h3><p>Explore an idea or a shared file.</p><p className="agent-empty__example">Try “Draw our workflow on the whiteboard.”</p></div>}
        {view.lines.map((line) => <article key={line.id} className={`agent-line agent-line--${line.role}`}>
          <header><strong>{line.role === 'user' ? 'You' : line.name}</strong>{line.audience === 'public' && <span>Shared with the room</span>}{line.playback === 'interrupted' && <span>Interrupted</span>}</header>
          {line.role === 'assistant' ? <Markdown text={line.text} /> : <p>{line.text}</p>}
          {!dictating && runtime.canSpeakReply(line.id) && <button className="agent-icon-button agent-line__send" type="button" aria-label="Send to everyone" aria-describedby={`send-tip-${line.id}`} onMouseEnter={() => setTooltipDismissed(false)} onFocus={() => setTooltipDismissed(false)} onClick={() => run(() => runtime.speakReply(line.id))}><Send size={20} aria-hidden="true" />{!tooltipDismissed && <span id={`send-tip-${line.id}`} className="agent-line__tooltip" role="tooltip">Read aloud to everyone</span>}</button>}
        </article>)}
      </div>
      {view.publicPersonalSpeaking && <div className="agent-public-status"><p role="status">Speaking to everyone · {view.status}</p></div>}
      <form onSubmit={submit} className="agent-compose">
        {!liveSession && !view.publicPersonalSpeaking && (view.personalActive || sending) && <p className="agent-note agent-compose__status" role="status">{sending ? 'Sending…' : view.status}{view.queued > 0 ? ` ${view.queued} queued.` : ''}</p>}
        {liveSession ? <div className="agent-live-session">
          <div className="agent-live-session__status" role="status">
            {startingLive ? <LoaderCircle className="agent-live-session__connecting" size={22} aria-hidden="true" /> : <AudioLines size={22} aria-hidden="true" />}
            <div><strong>{startingLive ? 'Connecting to Muse' : 'Live with Muse'}</strong><p>{startingLive ? 'Preparing your private microphone…' : view.status}{view.queued > 0 ? ` ${view.queued} queued.` : ''}</p></div>
          </div>
          <button ref={endLiveControl} className="agent-live-end" type="button" aria-label="End live conversation" title="End private live conversation" aria-pressed="true" onClick={() => { liveStartVersion.current++; runtime.stopPersonal(); setStartingLive(false); }}><Square size={16} fill="currentColor" aria-hidden="true" /><span>End</span></button>
        </div> : <div className="agent-compose__input">
          <textarea ref={composerInput} aria-label="Message Muse" readOnly={dictating} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
          }} maxLength={4000} rows={2} placeholder={dictating ? 'Listening…' : 'Think it through with Muse…'} />
          <div className="agent-compose__actions">
            {!dictating && <button type="button" className="agent-live" aria-label="Start live conversation" title="Talk continuously with Muse" aria-pressed="false" disabled={sending || view.personalActive} onClick={() => {
              const version = ++liveStartVersion.current;
              setStartingLive(true); followLatest.current = true; run(async () => { try { await runtime.startVoice(); } finally { if (version === liveStartVersion.current) setStartingLive(false); } });
            }}><AudioLines size={20} aria-hidden="true" /><span>Live</span></button>}
            {dictating && <div className="agent-dictation" role="status"><span className="agent-dictation__level" aria-hidden="true">{[.45, .8, 1, .8, .45].map((scale, index) => <i key={index} style={{ height: `${4 + dictated.level * 20 * scale}px` }} />)}</span>{dictated.status === 'starting' ? 'Connecting…' : dictated.status === 'stopping' ? 'Finishing…' : 'Recording'}</div>}
            <button type="button" className="agent-icon-button agent-voice" aria-label={dictating ? 'Stop recording' : 'Dictate message'} title={dictating ? 'Stop recording and keep draft' : 'Dictate message'} disabled={sending || dictationBusy || (!dictating && view.personalActive)} onClick={() => {
              if (dictating) run(async () => { const words = await dictation.stop(); setText([draftPrefix.current, words].filter(Boolean).join(' ')); });
              else { draftPrefix.current = text.trimEnd(); run(() => dictation.start()); }
            }}>{dictating ? <Square size={18} fill="currentColor" aria-hidden="true" /> : <Mic size={20} aria-hidden="true" />}</button>
            {responding
              ? <button className="agent-icon-button agent-send" type="button" aria-label="Stop response" title="Stop response" disabled={sending} onClick={() => runtime.stopPersonal()}><Square size={18} fill="currentColor" aria-hidden="true" /></button>
              : <button className="agent-icon-button agent-send" type="submit" aria-label="Send" title="Send message" disabled={(!dictating && !text.trim()) || sending || dictationBusy}><ArrowUp size={22} aria-hidden="true" /></button>}
          </div>
        </div>}
      </form>
    </section>}
    {editing && view.room.agents.some((agent) => agent.id === editing) && <AgentForm key={editing} editing initialConfig={view.room.agents.find((agent) => agent.id === editing)!.config} onCancel={() => setEditing(null)} onSave={async (config) => { await runtime.configure(editing, config); setEditing(null); }} />}
  </div>;
}

function AgentForm({ initialConfig, editing = false, onSave, onCancel }: { initialConfig: AgentConfig; editing?: boolean; onSave(config: AgentConfig): Promise<void>; onCancel(): void }): ReactNode {
  const [config, setConfig] = useState(initialConfig);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) => { setConfig((current) => ({ ...current, [key]: value })); setReview(false); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); const parsed = parseAgentConfig(config);
    if (!parsed) { setError('Complete the name, instructions, and language.'); return; }
    if (!editing && !review) { setReview(true); return; }
    setBusy(true); setError(null);
    try { await onSave(parsed); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save agent settings.'); } finally { setBusy(false); }
  };
  return <form className="agent-form" onSubmit={(event) => void submit(event)}>
    <button className="agent-back" type="button" onClick={onCancel} disabled={busy} autoFocus><ArrowLeft size={16} aria-hidden="true" /> Back to {config.kind === 'group' ? 'Room' : 'Muse'}</button>
    <h3>{editing ? 'Settings' : 'Add'} · {config.kind === 'personal' ? 'Muse' : 'Omni'}</h3>
    {editing && <p className="agent-note">Saving stops current agent work and applies the new settings. Conversation history is kept.</p>}
    {error && <p role="alert" className="agent-error">{error}</p>}
    <fieldset disabled={busy}><legend>Type and role</legend>

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
      {config.kind === 'personal' && <label className="agent-check"><input type="checkbox" checked={config.roomMessages === true} onChange={(event) => set('roomMessages', event.target.checked)} /> Allow posting to Room (visible to everyone)</label>}
      {config.kind === 'personal' && <p className="agent-note">Muse can read the shared whiteboard during a private request and edit it when you ask. Room posting is disabled unless you allow it above, then request a public message. Shared files and images are read as needed; unavailable files cannot be inspected.</p>}
      <p>{config.kind === 'personal' ? 'Replies stay private until you choose Send on a completed Muse message. Send reads only that message aloud to everyone.' : 'Omni prepares silently and speaks to everyone only after you approve by button or voice.'}</p>
      <p className="agent-note">Voice and text are recorded in the transcript for the selected audience. Instructions cannot override permissions.</p>
    </fieldset>
    {review && <div className="agent-review"><h4>Review before creating</h4><ConfigSummary config={parseAgentConfig(config)!} /></div>}
    <div className="agent-actions"><button className="agent-action" type="submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save settings' : review ? 'Create Muse' : 'Review settings'}</button></div>
  </form>;
}
function ConfigSummary({ config }: { config: AgentConfig }): ReactNode {
  return <dl className="agent-summary"><dt>Type</dt><dd>{config.kind}</dd><dt>Name</dt><dd>{config.name}</dd><dt>Language</dt><dd>{config.language}</dd><dt>Meeting sources</dt><dd>{config.source}</dd><dt>Public chat</dt><dd>{config.chat ? 'Included' : 'Excluded'}</dd><dt>System signals</dt><dd>{config.system ? 'Included' : 'Excluded'}</dd><dt>Shared screen</dt><dd>{config.screen ? 'Allowed' : 'Not allowed'}</dd><dt>Shared files and images</dt><dd>{config.files ? 'Allowed' : 'Not allowed'}</dd>{config.kind === 'personal' && <><dt>Shared whiteboard</dt><dd>Read during private requests; edit when asked</dd><dt>Room messages</dt><dd>{config.roomMessages ? 'Allowed when you request a public message' : 'Disabled — private replies only'}</dd></>}<dt>Audience</dt><dd>{config.audience}</dd></dl>;
}
