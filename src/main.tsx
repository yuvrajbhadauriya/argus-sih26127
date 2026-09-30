// ═══════════════════════════════════════════════════
// Main entry point with ErrorBoundary
// ═══════════════════════════════════════════════════

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@/app/App';
import { ErrorBoundary } from '@/app/ErrorBoundary';
// Self-hosted Inter (variable, font-display: swap; unicode-range subsets so only
// the needed ones download) — no render-blocking third-party font CSS.
import '@fontsource-variable/inter/wght.css';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
