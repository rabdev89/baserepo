import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

async function start() {
  // Only in dev builds; the import is tree-shaken out of production bundles.
  if (import.meta.env.DEV) {
    const { setupStub } = await import('fe-stub');
    await setupStub(); // no-op unless `npm run start:stub` is running (or ?stub=on)
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
}

start();
