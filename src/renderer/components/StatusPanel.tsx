import type { AppSnapshot } from '../../shared/ipc';

const statusText = {
  stopped: '已停止',
  running: '运行中',
  failed: '启动失败'
};

const modeText = {
  rule: '规则',
  global: '全局',
  direct: '直连'
};

type StatusPanelProps = {
  snapshot: AppSnapshot;
  message: string;
};

export function StatusPanel({ snapshot, message }: StatusPanelProps) {
  return (
    <section className="panel status-panel">
      <div className="metric-row">
        <span className="label">状态</span>
        <strong>{statusText[snapshot.status]}</strong>
      </div>
      <div className="metric-row">
        <span className="label">当前节点</span>
        <strong>{snapshot.currentNode}</strong>
      </div>
      <div className="metric-row">
        <span className="label">模式</span>
        <strong>{modeText[snapshot.mode]}</strong>
      </div>
      {message ? <p className="message">{message}</p> : null}
    </section>
  );
}
