// ═══════════════════════════════════════════════════
// DashboardLayout — app shell: Sidebar + TopBar + scrollable content
// Pages render inside <main> and bring their own <Page> padding.
// ═══════════════════════════════════════════════════

import { lazy, Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { LoadingState } from '@/shared/ui/LoadingState';
import { Toaster } from '@/shared/ui/Toaster';
import { SignInPrompt } from '@/features/auth/SignInPrompt';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

// Lazy: live-poll / replay alert wiring pulls in the alerts data layer.
const LiveAlertBridge = lazy(() => import('@/features/alerts/LiveAlertBridge'));

export function DashboardLayout() {
  return (
    <div className="flex h-dvh w-full overflow-hidden bg-canvas text-fg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[3000] focus:rounded-sm focus:bg-surface focus:px-3 focus:py-2 focus:text-[13px] focus:shadow-pop"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar />
        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto focus:outline-none">
          {/* Pages are lazy chunks: shell stays interactive while one loads */}
          <Suspense fallback={<LoadingState message="Loading module..." />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <Toaster />
      <SignInPrompt />
      <Suspense fallback={null}>
        <LiveAlertBridge />
      </Suspense>
    </div>
  );
}
