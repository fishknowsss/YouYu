import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installDevApiFallback } from './devApi';
import './styles.css';

installDevApiFallback();

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
