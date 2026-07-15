import { useRef, type ReactNode } from 'react';
import { BrandMark } from './BrandMark';

declare const __YOUYU_APP_VERSION__: string;
declare const __YOUYU_BUILD_CHANNEL__: 'standard' | 'no' | 'in' | string;
declare const __YOUYU_DISABLE_PET__: boolean;

export type PageKey = 'home' | 'nodes' | 'test' | 'petPreview' | 'settings';
export type UsageMode = 'easy' | 'advanced';

type AppShellProps = {
  page: PageKey;
  usageMode: UsageMode;
  inert?: boolean;
  children: ReactNode;
  onPageChange: (page: PageKey) => void;
  onAdvancedUnlock?: () => void;
  onRegistrationRequest?: () => void;
};

export function AppShell({
  page,
  usageMode,
  inert = false,
  children,
  onPageChange,
  onAdvancedUnlock,
  onRegistrationRequest
}: AppShellProps) {
  const navItems: Array<{ key: PageKey; label: string }> = [
    { key: 'home', label: '首页' },
    { key: 'nodes', label: '节点' },
    { key: 'test', label: '测试' },
    { key: 'settings', label: '设置' }
  ];
  if (!__YOUYU_DISABLE_PET__) {
    navItems.splice(3, 0, { key: 'petPreview', label: '桌宠' });
  }
  const versionLabel = getVersionLabel(__YOUYU_APP_VERSION__, __YOUYU_BUILD_CHANNEL__);
  const registrationUnlockClicks = useRef(0);

  function handleRegistrationUnlockClick() {
    registrationUnlockClicks.current += 1;
    if (registrationUnlockClicks.current < 7) return;

    registrationUnlockClicks.current = 0;
    onRegistrationRequest?.();
  }

  return (
    <div
      className={`app-shell ${usageMode === 'easy' ? 'easy-shell' : 'advanced-shell'}`}
      inert={inert}
      aria-hidden={inert || undefined}
    >
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
                aria-current={page === item.key ? 'page' : undefined}
                onClick={() => onPageChange(item.key)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <button
            type="button"
            className="version-chip"
            aria-label={`当前版本 ${versionLabel}`}
            onClick={handleRegistrationUnlockClick}
          >
            <span>{versionLabel}</span>
          </button>
        </aside>
      )}
      <main className="main-surface">{children}</main>
      {usageMode === 'easy' && onAdvancedUnlock && (
        <button
          type="button"
          className="advanced-unlock-hotspot"
          aria-label="进入专业模式"
          onClick={onAdvancedUnlock}
        />
      )}
    </div>
  );
}

function getVersionLabel(version: string, channel: string): string {
  if (channel === 'in') return `v${version}-in`;
  if (channel === 'no') return `v${version}-no`;
  return `v${version}`;
}
