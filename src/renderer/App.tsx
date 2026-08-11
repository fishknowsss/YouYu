import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { TrafficRegistrationInput } from '../shared/ipc';
import { isActionErrorMessage } from './actionMessages';
import { AppShell } from './components/AppShell';
import { useAppController } from './hooks/useAppController';
import { Home } from './pages/Home';
import { NodeSelect } from './pages/NodeSelect';
import { Settings } from './pages/Settings';
import { TestPage } from './pages/TestPage';

export { createOperationRequestTracker, getActionErrorMessage, startEasyProxy, withTimeout } from './appActions';

const PetPreviewPage = lazy(async () => {
  const module = await import('./pages/PetPreviewPage');
  return { default: module.PetPreviewPage };
});

export function App() {
  const controller = useAppController();

  useEffect(() => {
    const wakeRemoteConfig = () => {
      const api = window.youyu;
      if (api) void api.wakeRemoteConfig().catch(() => undefined);
    };
    window.addEventListener('online', wakeRemoteConfig);
    return () => window.removeEventListener('online', wakeRemoteConfig);
  }, []);

  if (controller.snapshotLoaded && (!controller.registered || controller.registrationSwitchOpen)) {
    const switchingUser = controller.registered && controller.registrationSwitchOpen;
    return (
      <RegistrationGate
        busy={controller.busy}
        message={controller.message}
        mode={switchingUser ? 'switch' : 'initial'}
        initialName={switchingUser ? controller.snapshot.trafficIdentity?.name : undefined}
        onCancel={switchingUser ? controller.closeRegistrationSwitch : undefined}
        onRegister={controller.registerTrafficIdentity}
      />
    );
  }

  return (
    <>
      <AppShell
        page={controller.page}
        usageMode={controller.usageMode}
        onPageChange={controller.setPage}
        onAdvancedUnlock={controller.handleAdvancedUnlockClick}
        onRegistrationRequest={controller.openRegistrationSwitch}
      >
        {controller.page === 'home' && (
          <Home
            usageMode={controller.usageMode}
            snapshot={controller.snapshot}
            busy={controller.busy}
            busyLabel={controller.busyLabel}
            message={controller.message}
            onQuickStart={controller.quickStart}
            onStart={controller.start}
            onStop={controller.stop}
            onRepair={controller.repair}
            onModeChange={controller.setMode}
            onStrategyChange={controller.selectStrategy}
            onOpenNodes={controller.openNodes}
            onUsageModeChange={controller.changeUsageMode}
            onCheckUpdate={controller.checkForUpdates}
            onInstallUpdate={controller.installUpdate}
          />
        )}
        {controller.page === 'nodes' && (
          <NodeSelect
            snapshot={controller.snapshot}
            busy={controller.busy}
            message={controller.message}
            testingAll={controller.testingAllNodes}
            switchingNode={controller.switchingNode}
            onSelect={controller.selectNode}
            onTestNode={controller.testNode}
            onTestAll={controller.testAllNodes}
            onCancelTestAll={controller.cancelNodeTests}
            onRefresh={controller.updateSubscription}
          />
        )}
        {controller.page === 'test' && <TestPage snapshot={controller.snapshot} />}
        {controller.page === 'petPreview' && (
          <Suspense
            fallback={
              <div className="page-loading" role="status">
                加载中
              </div>
            }
          >
            <PetPreviewPage />
          </Suspense>
        )}
        {controller.page === 'settings' && (
          <Settings
            snapshot={controller.snapshot}
            busy={controller.busy}
            busyLabel={controller.busyLabel}
            message={controller.settingsMessage}
            onRepair={controller.settingsRepair}
            onSave={controller.saveSettings}
            onSyncRemoteConfig={controller.syncRemoteConfig}
            onCheckUpdate={controller.checkForUpdates}
            onInstallUpdate={controller.installSettingsUpdate}
            onExportDiagnostics={controller.exportDiagnostics}
          />
        )}
      </AppShell>
      {controller.busyLabel === '修复中' && (
        <div className="busy-overlay" aria-live="polite" aria-label="修复中">
          <div className="busy-spinner" />
          <span>修复中</span>
        </div>
      )}
    </>
  );
}

export function RegistrationGate({
  busy,
  message,
  mode = 'initial',
  initialName = '',
  onRegister,
  onCancel
}: {
  busy: boolean;
  message: string;
  mode?: 'initial' | 'switch';
  initialName?: string;
  onRegister: (input: TrafficRegistrationInput) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [passphrase, setPassphrase] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const canSubmit = Boolean(name.trim() && passphrase.trim());
  const switchingUser = mode === 'switch';
  const statusIsError = !busy && isActionErrorMessage(message);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    nameInputRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  function submit() {
    if (busy || !canSubmit) return;
    void onRegister({ name: name.trim(), passphrase: passphrase.trim() });
  }

  function trapFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') return;
    const focusable = getFocusableElements(dialogRef.current);
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="registration-gate"
      role="dialog"
      aria-modal="true"
      aria-labelledby="registration-title"
      aria-describedby="registration-description registration-status"
    >
      <section ref={dialogRef} className="registration-dialog" aria-busy={busy} onKeyDown={trapFocus}>
        <div>
          <h1 id="registration-title">{switchingUser ? '重新登记' : '使用登记'}</h1>
          <p id="registration-description">{switchingUser ? '输入姓名和口令以切换用户' : '填写姓名和口令后开始使用'}</p>
        </div>
        <form
          className="registration-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="field">
            <span>姓名</span>
            <input
              ref={nameInputRef}
              name="name"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              readOnly={busy}
              aria-disabled={busy}
              required
            />
          </label>
          <label className="field">
            <span>口令</span>
            <input
              name="registration-passphrase"
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              readOnly={busy}
              aria-disabled={busy}
              required
            />
          </label>
          <div className={`registration-actions${switchingUser ? ' has-cancel' : ''}`}>
            {switchingUser && (
              <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>
                取消
              </button>
            )}
            <button type="submit" className="wide-button" disabled={busy || !canSubmit}>
              {switchingUser ? '切换' : '登记'}
            </button>
          </div>
          <div
            id="registration-status"
            className={`registration-status${statusIsError ? ' is-error' : ''}`}
            aria-live="polite"
            aria-atomic="true"
          >
            {busy && <span className="registration-spinner" aria-hidden="true" />}
            <span>{busy ? (switchingUser ? '切换中' : '登记中') : message}</span>
          </div>
        </form>
      </section>
    </div>
  );
}

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  );
}
