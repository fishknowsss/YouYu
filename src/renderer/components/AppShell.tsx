import type { ReactNode } from 'react';
import { BrandMark } from './BrandMark';

declare const __YOUYU_APP_VERSION__: string;
declare const __YOUYU_BUILD_CHANNEL__: 'standard' | 'no' | 'in' | string;

export type PageKey = 'home' | 'nodes' | 'settings';
export type UsageMode = 'easy' | 'advanced';

type AppShellProps = {
  page: PageKey;
  usageMode: UsageMode;
  children: ReactNode;
  onPageChange: (page: PageKey) => void;
};

export function AppShell({ page, usageMode, children, onPageChange }: AppShellProps) {
  const navItems: Array<{ key: PageKey; label: string }> = [
    { key: 'home', label: '首页' },
    { key: 'nodes', label: '节点' },
    { key: 'settings', label: '设置' }
  ];
  const versionLabel = getVersionLabel(__YOUYU_APP_VERSION__, __YOUYU_BUILD_CHANNEL__);

  return (
    <div className={`app-shell ${usageMode === 'easy' ? 'easy-shell' : 'advanced-shell'}`}>
      {usageMode === 'advanced' && (
        <aside className="sidebar">
          <div className="brand-lockup">
            <BrandMark size="sm" />
            <div className="brand-text">
              <span>YouYu</span>
              <strong>有鱼</strong>
            </div>
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
          <div className="version-chip" aria-label={`版本 ${versionLabel}`}>
            <span>{versionLabel}</span>
          </div>
        </aside>
      )}
      <main className="main-surface">{children}</main>
    </div>
  );
}

function getVersionLabel(version: string, channel: string): string {
  if (channel === 'in') return `v${version}-in`;
  if (channel === 'no') return `v${version}-no`;
  return `v${version}`;
}
