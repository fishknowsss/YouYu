import { useEffect, useRef, useState } from 'react';
import type { DesktopNoticeApi, DesktopNoticeSnapshot } from '../shared/ipc';
import { UserNoticeBanner } from './components/UserNoticeBanner';

export function DesktopNoticeApp() {
  const [snapshot, setSnapshot] = useState<DesktopNoticeSnapshot | undefined>();
  const initialSnapshotRequested = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const api = window.youyu as DesktopNoticeApi | undefined;
    if (!api)
      return () => {
        mounted.current = false;
      };
    if (!initialSnapshotRequested.current) {
      initialSnapshotRequested.current = true;
      void api
        .getSnapshot()
        .then((next) => {
          if (mounted.current) setSnapshot(next);
        })
        .catch(() => undefined);
    }
    const dispose = api.onSnapshotUpdated((next) => {
      if (mounted.current) setSnapshot(next);
    });
    return () => {
      mounted.current = false;
      dispose?.();
    };
  }, []);

  async function acknowledge(revision: number): Promise<boolean> {
    const api = window.youyu as DesktopNoticeApi | undefined;
    if (!api) return false;
    const next = await api.acknowledgeUserNotice(revision);
    if (!next) return false;
    setSnapshot(next);
    return true;
  }

  return (
    <main className="desktop-notice-root" aria-label="YouYu 通知">
      <UserNoticeBanner notice={snapshot?.userNotice} onAcknowledge={acknowledge} variant="desktop" />
    </main>
  );
}
