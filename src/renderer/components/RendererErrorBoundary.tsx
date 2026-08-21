import { Component, type ErrorInfo, type ReactNode } from 'react';

type RendererErrorBoundaryProps = {
  children: ReactNode;
  onRetry?: () => void;
};

type RendererErrorBoundaryState = {
  failed: boolean;
  exportStatus: '' | 'success' | 'error';
};

export class RendererErrorBoundary extends Component<RendererErrorBoundaryProps, RendererErrorBoundaryState> {
  state: RendererErrorBoundaryState = { failed: false, exportStatus: '' };

  static getDerivedStateFromError(): Partial<RendererErrorBoundaryState> {
    return { failed: true, exportStatus: '' };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    reportRendererError(error);
  }

  private retry = (): void => {
    if (this.props.onRetry) {
      this.props.onRetry();
      this.setState({ failed: false, exportStatus: '' });
      return;
    }
    window.location.reload();
  };

  private exportDiagnostics = async (): Promise<void> => {
    const api = window.youyu;
    if (!api || typeof api.exportDiagnostics !== 'function') return;
    this.setState({ exportStatus: '' });
    try {
      const result = await api.exportDiagnostics();
      if (!result.canceled) this.setState({ exportStatus: 'success' });
    } catch {
      this.setState({ exportStatus: 'error' });
    }
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const canExport = typeof window.youyu?.exportDiagnostics === 'function';
    return (
      <main className="renderer-error-state" role="alert" aria-labelledby="renderer-error-title">
        <h1 id="renderer-error-title">页面暂时无法显示</h1>
        <div className="renderer-error-actions">
          <button type="button" className="wide-button" onClick={this.retry}>
            重试
          </button>
          {canExport && (
            <button type="button" className="secondary-button" onClick={() => void this.exportDiagnostics()}>
              导出诊断
            </button>
          )}
        </div>
        {this.state.exportStatus && (
          <p className={this.state.exportStatus === 'error' ? 'is-error' : ''} aria-live="polite">
            {this.state.exportStatus === 'success' ? '诊断已导出' : '导出失败，请重试'}
          </p>
        )}
      </main>
    );
  }
}

export function createRendererErrorCode(error: unknown): string {
  const source = error instanceof Error ? `${error.name}:${error.message}` : typeof error;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `R-${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

export function reportRendererError(error: unknown): void {
  console.error(`[renderer-error] ${createRendererErrorCode(error)}`);
}
