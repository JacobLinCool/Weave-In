import type { AutoReminders } from './auto-reminders';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { LockKeyhole, X } from 'lucide-react';
import { type PrivateNotice, PrivateNotices } from './private-notices';

function Evidence({ notice }: { notice: PrivateNotice }) {
  return (
    <details>
      <summary>View evidence</summary>
      {notice.evidence.map((entry, index) => (
        <blockquote key={`${entry.seq}-${index}`}>
          <strong>{entry.name}</strong>
          <p>{entry.text}</p>
        </blockquote>
      ))}
    </details>
  );
}

export interface NoticeActions { onSpeak?: ((text: string) => Promise<void>) | undefined; onDiscuss?: ((text: string) => Promise<void>) | undefined }
export function PrivateNoticeToast({ store, onHistory, ...actions }: { store: PrivateNotices; onHistory(): void } & NoticeActions) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [selected, setSelected] = useState<string | null>(null);
  const notice = state.notices.find((n) => n.id === selected && !n.collapsed && !n.read && n.status !== 'dismissed');
  useEffect(() => {
    if (notice) return; // A new reminder must not replace the one being read.
    setSelected(state.notices.find((n) => n.status === 'active' && !n.collapsed && !n.read)?.id ?? null);
  }, [notice, state.notices]);
  if (!notice) return null;
  return <TimedNotice key={notice.id} notice={notice} store={store} onHistory={onHistory} {...actions} />;
}

function TimedNotice({
  notice,
  store,
  onHistory,
  onSpeak,
  onDiscuss,
}: {
  notice: PrivateNotice;
  store: PrivateNotices;
  onHistory(): void;
} & NoticeActions) {
  const card = useRef<HTMLElement>(null);
  const remaining = useRef(15000);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [position, setPosition] = useState({ bottom: 80, fits: false });
  // Float above controls, moving up only as needed to avoid any intersecting caption.
  useLayoutEffect(() => {
    const element = card.current;
    const stage = element?.closest('.meeting-stage');
    if (!element || !stage) return;
    const update = () => {
      const bounds = stage.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const footer = stage.querySelector('.meeting-footer')?.getBoundingClientRect();
      let bottom = Math.min(footer?.top ?? bounds.bottom, window.innerHeight) - 12;
      const obstacles = [...stage.querySelectorAll('.tile-caption, .error-notice')]
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width && r.height && r.right > box.left && r.left < box.right)
        .sort((a, b) => b.bottom - a.bottom);
      for (const obstacle of obstacles) {
        if (bottom > obstacle.top && bottom - box.height < obstacle.bottom) bottom = obstacle.top - 8;
      }
      const next = { bottom: bounds.bottom - bottom, fits: bottom - box.height >= Math.max(bounds.top, 0) + 8 };
      setPosition((old) => (old.bottom === next.bottom && old.fits === next.fits ? old : next));
    };
    const resize = new ResizeObserver(update);
    resize.observe(stage);
    resize.observe(element);
    const mutations = new MutationObserver(update);
    mutations.observe(stage, { childList: true, subtree: true, characterData: true });
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    setHovered(element.matches(':hover'));
    update();
    return () => {
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, []);
  const paused = hovered || focused || !position.fits;
  useEffect(() => {
    if (paused) return;
    const started = performance.now();
    const timer = window.setTimeout(() => store.collapse(notice.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (performance.now() - started));
    };
  }, [paused, notice.id, store]);
  const focusHistory = () => document.querySelector<HTMLButtonElement>('[data-private-tab]')?.focus();
  return (
    <section
      ref={card}
      className="private-notice-toast"
      aria-label="Private reminder from Muse"
      style={{ bottom: position.bottom, visibility: position.fits ? 'visible' : 'hidden' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <div className="private-notice-dock__heading">
        <span>
          <LockKeyhole size={13} /> Muse · Only you
        </span>
        <button
          type="button"
          aria-label="Collapse reminder"
          onClick={() => {
            focusHistory();
            store.collapse(notice.id);
          }}
        >
          <X size={16} />
        </button>
      </div>
      <div className="private-notice-dock__body">
        <p role="status" aria-live="polite" aria-atomic="true">
          {notice.text}
        </p>
      </div>
      <ReminderActions notice={notice} onSpeak={onSpeak} onDiscuss={onDiscuss} />
      <div className="private-notice-actions">
        <button
          type="button"
          onClick={() => {
            store.markRead([notice.id]);
            onHistory();
            focusHistory();
          }}
        >
          View evidence
        </button>
        <button
          type="button"
          onClick={() => {
            focusHistory();
            store.collapse(notice.id);
          }}
        >
          Later
        </button>
      </div>
    </section>
  );
}

function ReminderActions({ notice, onSpeak, onDiscuss }: { notice: PrivateNotice } & NoticeActions) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: (text: string) => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(notice.text); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Please try again.'); }
    finally { setBusy(false); }
  };
  return <>
    <div className="private-notice-actions">
      {onSpeak && <button type="button" disabled={busy} onClick={() => void run(onSpeak)}>Speak for me</button>}
      {onDiscuss && <button type="button" disabled={busy} onClick={() => void run(onDiscuss)}>Discuss privately</button>}
    </div>
    {error && <p role="alert">{error}</p>}
  </>;
}

export function PrivateNoticeHistory({ store, monitor, ...actions }: { store: PrivateNotices; monitor: AutoReminders } & NoticeActions) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [expanded, setExpanded] = useState(() => state.notices.some((notice) => !notice.read));
  const monitoring = useSyncExternalStore(monitor.subscribe, monitor.getSnapshot);
  useEffect(() => {
    if (expanded) store.markRead(state.notices.filter((n) => !n.read).map((n) => n.id));
  }, [state, store, expanded]);
  if (!state.notices.length && monitoring.status !== 'unavailable') return null;
  return (
    <div className="private-notice-history" role="tabpanel" aria-label="Private reminders">
      {monitoring.status === 'unavailable' && <p role="status">Reminders unavailable · retrying</p>}
      <details className="private-reminder-list" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>Private reminders · {state.notices.length}{state.notices.some((notice) => !notice.read) ? ' · New' : ''}</summary>
      {state.notices.map((notice) => (
        <article key={notice.id}>
          <header>
            <time dateTime={new Date(notice.at).toISOString()}>
              {new Date(notice.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>
            <span>{notice.status}</span>
          </header>
          <p>{notice.text}</p>
          <Evidence notice={notice} />
          <ReminderActions notice={notice} {...actions} />
          {notice.status === 'active' && (
            <button type="button" onClick={() => store.dismiss(notice.id)}>
              Dismiss
            </button>
          )}
        </article>
      ))}
      </details>
    </div>
  );
}
