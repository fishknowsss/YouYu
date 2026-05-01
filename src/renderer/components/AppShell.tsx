import type { ReactNode } from 'react';
import { BrandMark } from './BrandMark';

export type PageKey = 'home' | 'nodes' | 'settings';
export type UsageMode = 'easy' | 'advanced';

type AppShellProps = {
  page: PageKey;
  usageMode: UsageMode;
  children: ReactNode;
  onPageChange: (page: PageKey) => void;
  onUsageModeChange: (mode: UsageMode) => void;
};

export function AppShell({ page, usageMode, children, onPageChange, onUsageModeChange }: AppShellProps) {
  const navItems: Array<{ key: PageKey; label: string }> =
    usageMode === 'easy'
      ? [{ key: 'home', label: '首页' }]
      : [
          { key: 'home', label: '首页' },
          { key: 'nodes', label: '节点' },
          { key: 'settings', label: '设置' }
        ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <BrandMark size="sm" />
          <div className="brand-text">
            <span>YouYu</span>
            <strong>有鱼</strong>
          </div>
        </div>
        <div className="usage-switch" aria-label="使用模式">
          <button
            className={usageMode === 'easy' ? 'active' : ''}
            onClick={() => onUsageModeChange('easy')}
          >
            快速
          </button>
          <button
            className={usageMode === 'advanced' ? 'active' : ''}
            onClick={() => onUsageModeChange('advanced')}
          >
            专业
          </button>
        </div>
        <nav className="nav-list" aria-label="页面">
          {navItems.map((item) => (
            <button
              key={item.key}
              className={page === item.key ? 'active' : ''}
              onClick={() => onPageChange(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="main-surface">{children}</main>
    </div>
  );
}
