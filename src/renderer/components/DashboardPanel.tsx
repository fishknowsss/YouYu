import type { ReactNode } from 'react';

type DashboardPanelProps = {
  title: string;
  meta?: ReactNode;
  className?: string;
  children: ReactNode;
};

export function DashboardPanel({ title, meta, className = '', children }: DashboardPanelProps) {
  return (
    <section className={`panel dashboard-panel${className ? ` ${className}` : ''}`}>
      <div className="dashboard-panel-heading">
        <h2>{title}</h2>
        {meta}
      </div>
      <div className="dashboard-panel-body">{children}</div>
    </section>
  );
}
