// ═══════════════════════════════════════════════════
// DashboardLayout — app shell: Sidebar + TopBar + scrollable content
// Pages render inside <main> and bring their own <Page> padding.
// ═══════════════════════════════════════════════════

import { lazy, Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { LoadingState } from '@/shared/ui/LoadingState';
import { Toaster } from '@/shared/ui/Toaster';
import { SignInPrompt } from '@/features/auth/SignInPrompt';
import { useIsPhone } from '@/shared/lib/useMediaQuery';
import { BottomNav } from './BottomNav';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

// Lazy: live-poll / replay alert wiring pulls in the alerts data layer.
const LiveAlertBridge = lazy(() => import('@/features/alerts/LiveAlertBridge'));

export function DashboardLayout() {
  // Phones (< 768px): bottom tab bar instead of the icon rail. Tablets keep the
  // collapsed rail, desktop the full sidebar.
  const phone = useIsPhone();
  return (
    <div className="relative flex h-dvh w-full overflow-hidden bg-canvas text-fg">
      <a
        href="#main"
        className="absolute left-3 top-0 z-[3000] -translate-y-[200%] rounded-sm bg-surface px-3 py-2 text-[13px] shadow-pop focus:translate-y-3"
      >
        Skip to content
      </a>
      {!phone && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar />
        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto focus:outline-none">
          {/* Pages are lazy chunks: shell stays interactive while one loads */}
          <Suspense fallback={<LoadingState message="Loading module..." />}>
            <Outlet />
          </Suspense>
        </main>
        {phone && <BottomNav />}
      </div>
      <Toaster />
      <SignInPrompt />
      <Suspense fallback={null}>
        <LiveAlertBridge />
      </Suspense>
    </div>
  );
}
