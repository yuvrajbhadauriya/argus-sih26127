// ═══════════════════════════════════════════════════
// Main entry point with ErrorBoundary
// ═══════════════════════════════════════════════════

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@/app/App';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { findRoute } from '@/app/routes';
// Self-hosted Inter (variable, font-display: swap; unicode-range subsets so only
// the needed ones download) — no render-blocking third-party font CSS.
import '@fontsource-variable/inter/wght.css';
import './index.css';

function render() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}

// The current route's chunk is already downloading (modulepreload hints from
// the build). Wait for it — capped, the inline boot spinner is showing — so
// the first render paints the real page instead of a Suspense fallback.
const initial = findRoute(window.location.pathname);
if (initial) {
  Promise.race([initial.page.preload(), new Promise((r) => setTimeout(r, 3000))]).then(render, render);
} else {
  render();
}
