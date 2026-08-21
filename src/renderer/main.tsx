import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { RendererErrorBoundary } from './components/RendererErrorBoundary';
import { DesktopNoticeApp } from './DesktopNoticeApp';
import { installDevApiFallback } from './devApi';
import './styles.css';

declare const __YOUYU_DISABLE_PET__: boolean;

installDevApiFallback();

const LazyPetApp = lazy(async () => {
  const module = await import('./PetApp');
  return { default: module.PetApp };
});

export function RendererRoot() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  if (view === 'notice') {
    setWindowClass('desktop-notice-window');
    return <DesktopNoticeApp />;
  }

  if (!__YOUYU_DISABLE_PET__ && view === 'pet') {
    setWindowClass('pet-window');
    return (
      <Suspense
        fallback={
          <div className="page-loading" role="status">
            正在加载
          </div>
        }
      >
        <LazyPetApp />
      </Suspense>
    );
  }

  setWindowClass();
  return <App />;
}

function setWindowClass(className?: 'desktop-notice-window' | 'pet-window'): void {
  for (const target of [document.documentElement, document.body]) {
    target.classList.toggle('desktop-notice-window', className === 'desktop-notice-window');
    target.classList.toggle('pet-window', className === 'pet-window');
  }
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <RendererErrorBoundary>
      <RendererRoot />
    </RendererErrorBoundary>
  </React.StrictMode>
);
