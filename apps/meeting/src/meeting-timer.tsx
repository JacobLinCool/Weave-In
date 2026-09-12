import { useEffect, useState, type ReactNode } from 'react';
import { Clock3 } from 'lucide-react';

export function formatMeetingDuration(seconds: number): string {
  const elapsed = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(elapsed / 3_600);
  const minutes = Math.floor(elapsed / 60) % 60;
  const remainder = elapsed % 60;
  const clock = `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${clock}` : clock;
}

export function MeetingTimer({ startedAt }: { startedAt: number }): ReactNode {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = (): void => setNow(Date.now());
    update();
    const interval = window.setInterval(update, 1_000);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', update);
    };
  }, [startedAt]);

  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1_000));
  return (
    <span className="meeting-timer" role="timer" aria-live="off" aria-label="Meeting elapsed time" title="Time since this room started">
      <Clock3 size={13} aria-hidden="true" />
      <time dateTime={`PT${elapsed}S`}>{formatMeetingDuration(elapsed)}</time>
    </span>
  );
}
