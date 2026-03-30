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

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('App crashed:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          fontFamily: 'sans-serif',
          color: '#ccc',
          background: '#1a1a2e',
          gap: '16px',
        }}>
          <h1 style={{ fontSize: '1.5rem', color: '#ff6b6b' }}>Something went wrong</h1>
          <pre style={{
            maxWidth: '600px',
            padding: '16px',
            background: '#16213e',
            borderRadius: '8px',
            fontSize: '0.85rem',
            overflow: 'auto',
            maxHeight: '200px',
          }}>
            {this.state.error?.message}
          </pre>
          <button
            className="btn btn-primary btn-lg"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ErrorBoundary>
    </React.StrictMode>
  );
}
