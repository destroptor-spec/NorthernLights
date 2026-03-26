/// <reference types="vite-plugin-pwa/client" />
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { createBuffer } from './polyfills/buffer';
import { registerSW } from 'virtual:pwa-register';

// Initialize Buffer polyfill for music-metadata-browser
createBuffer();

// Register the PWA service worker
registerSW({ immediate: true });

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>
  );
}
