import type { AppStatus } from '../../shared/ipc';

type PowerButtonProps = {
  status: AppStatus;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
};

export function PowerButton({ status, busy, onStart, onStop }: PowerButtonProps) {
  const running = status === 'running';

  return (
    <button
      className={`power-button ${running ? 'running' : ''}`}
      disabled={busy}
      onClick={running ? onStop : onStart}
    >
      <span className="power-dot" aria-hidden="true" />
      <span>{busy ? '处理中' : running ? '停止代理' : '启动代理'}</span>
    </button>
  );
}
