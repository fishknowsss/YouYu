import type { ReactNode } from 'react';

type WorkspaceHeaderProps = {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
};

export function WorkspaceHeader({ title, description, actions }: WorkspaceHeaderProps) {
  return (
    <header className="workspace-header">
      <div className="workspace-header-copy">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}
