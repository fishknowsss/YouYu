import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installDevApiFallback } from './devApi';
import './styles.css';

declare const __YOUYU_DISABLE_PET__: boolean;

installDevApiFallback();

async function getRootComponent() {
  const params = new URLSearchParams(window.location.search);
  const isPetView = !__YOUYU_DISABLE_PET__ && params.get('view') === 'pet';
  if (!isPetView) return App;

  document.documentElement.classList.add('pet-window');
  document.body.classList.add('pet-window');
  const module = await import('./PetApp');
  return module.PetApp;
}

const RootComponent = await getRootComponent();

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <RootComponent />
  </React.StrictMode>
);
