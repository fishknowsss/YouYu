import { useEffect, useState } from 'react';
import type { UserNotice } from '../../shared/ipc';

const maximumTimerDelayMs = 2_147_000_000;

export function UserNoticeBanner({
  notice,
  onAcknowledge,
  variant = 'desktop'
}: {
  notice?: UserNotice;
  onAcknowledge: (revision: number) => boolean | Promise<boolean>;
  variant?: 'desktop';
}) {
  const [submitting, setSubmitting] = useState(false);
  const [currentTime, setCurrentTime] = useState(Date.now);

  useEffect(() => setSubmitting(false), [notice?.revision]);
  useEffect(() => {
    if (!notice) return;
    const expiresAt = Date.parse(notice.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        setCurrentTime(expiresAt);
        return;
      }
      timer = setTimeout(schedule, Math.min(remaining, maximumTimerDelayMs));
    };
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [notice]);

  const expiresAt = notice ? Date.parse(notice.expiresAt) : Number.NaN;
  if (!notice || !Number.isFinite(expiresAt) || expiresAt <= currentTime) return null;
  const revision = notice.revision;

  async function acknowledge() {
    if (submitting) return;
    setSubmitting(true);
    try {
      const accepted = await onAcknowledge(revision);
      if (!accepted) setSubmitting(false);
    } catch {
      setSubmitting(false);
    }
  }

  const warning = notice.tone === 'warning';
  return (
    <div className={`user-notice-layer ${variant}`}>
      <section
        className={`user-notice-banner ${warning ? 'warning' : 'info'}`}
        role={warning ? 'alert' : 'status'}
        aria-live={warning ? 'assertive' : 'polite'}
        aria-labelledby="user-notice-title"
        aria-describedby="user-notice-message"
      >
        <span className="user-notice-mark" aria-hidden="true">
          {warning ? '!' : 'i'}
        </span>
        <div className="user-notice-copy">
          <strong id="user-notice-title">{warning ? '重要通知' : '通知'}</strong>
          <p id="user-notice-message">{notice.message}</p>
        </div>
        <div className="user-notice-actions">
          <button
            type="button"
            className="user-notice-confirm"
            disabled={submitting}
            onClick={() => void acknowledge()}
          >
            {submitting ? '确认中' : '知道了'}
          </button>
        </div>
      </section>
    </div>
  );
}
