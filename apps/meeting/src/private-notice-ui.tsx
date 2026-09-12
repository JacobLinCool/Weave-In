import type { AutoReminders } from './auto-reminders';
import { useSyncExternalStore } from 'react';
import { EyeOff, LockKeyhole } from 'lucide-react';
import { type PrivateNotice, PrivateNotices } from './private-notices';

function Evidence({ notice }: { notice: PrivateNotice }) {
  return <details><summary>View evidence</summary>{notice.evidence.map((entry, index) =>
    <blockquote key={`${entry.seq}-${index}`}><strong>{entry.name}</strong><p>{entry.text}</p></blockquote>,
  )}</details>;
}

export function PrivateNoticeDock({ store, monitor, onHistory }: { store: PrivateNotices; monitor: AutoReminders; onHistory(): void }) {
  const monitoring = useSyncExternalStore(monitor.subscribe, monitor.getSnapshot);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const active = state.notices.find((item) => item.status === 'active');
  return <section className="private-notice-dock" aria-label="Private reminders">
    <div className="private-notice-dock__heading">
      <span><LockKeyhole size={13} /> Only you · {state.hidden ? 'Hidden' : active ? 'Private reminder' : 'No reminders'}</span>
      <button type="button" aria-pressed={state.hidden} onClick={() => store.setHidden(!state.hidden)}><EyeOff size={13} />{state.hidden ? 'Show' : 'Hide'}</button>
      <button type="button" onClick={onHistory}>History</button>
    </div>
    <div className="private-monitor" aria-label="Automatic reminders">
      <span role="status">{monitoring.status === 'checking' ? 'Checking discussion…' : monitoring.status === 'unavailable' ? 'Auto reminders unavailable · retrying' : monitoring.status === 'paused' ? 'Auto reminders paused' : 'Auto reminders on'}</span>
      <button type="button" onClick={() => monitor.setEnabled(!monitoring.enabled)}>{monitoring.enabled ? 'Pause' : 'Resume'}</button>
    </div>
    {!state.hidden && active && <div className="private-notice-dock__body">
      <p role="status" aria-live="polite" aria-atomic="true">{active.text}</p>
      <div className="private-notice-actions"><button type="button" onClick={onHistory}>View evidence</button><button type="button" onClick={() => store.dismiss(active.id)}>Dismiss</button></div>
    </div>}
  </section>;
}

export function PrivateNoticeHistory({ store }: { store: PrivateNotices }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return <div className="private-notice-history" role="tabpanel" aria-label="Private reminders">
    <p>Only in this browser. Screen sharing can reveal this content.</p>
    <button type="button" aria-pressed={state.hidden} onClick={() => store.setHidden(!state.hidden)}>{state.hidden ? 'Show private content' : 'Hide private content'}</button>
    {state.hidden ? <p>Private content hidden.</p> : <>
      <p>Automatic detection sends recent transcript text and previous automatic reminders to Gemini through our server. Our server does not store them. Reminders are delivered only to the person who raised the concern. Pause stops analysis; Hide only hides private content. No assistant connection is required.</p>
      {!state.notices.length && <p>No reminders yet. Automatic reminders appear when an unresolved concern you raised is bypassed during a decision.</p>}
      {state.notices.map((notice) => <article key={notice.id}>
        <header><time dateTime={new Date(notice.at).toISOString()}>{new Date(notice.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><span>{notice.status}</span></header>
        <p>{notice.text}</p><Evidence notice={notice} />
        {notice.status === 'active' && <button type="button" onClick={() => store.dismiss(notice.id)}>Dismiss</button>}
      </article>)}
    </>}
  </div>;
}
