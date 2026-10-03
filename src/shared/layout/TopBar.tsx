// ═══════════════════════════════════════════════════
// TopBar — plate search, system status, IST clock, alerts, theme, user
// ═══════════════════════════════════════════════════

import { lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { BellIcon } from 'lucide-react';
import { IconButton } from '@/shared/ui/Button';
import { useIsPhone } from '@/shared/lib/useMediaQuery';
import { GlobalPlateSearch } from './GlobalPlateSearch';
import { MobileHeader } from './MobileHeader';
import { LiveClock } from './LiveClock';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';
import { useNavBadges } from './useNavBadges';

// Lazy: pulls in the cameras data layer (and Supabase) off the critical path.
const SystemStatus = lazy(() => import('./SystemStatus'));
// AI engine heartbeat (public.model_status); renders nothing without a database.
const AiEngineStatusPill = lazy(() => import('@/features/ai-engine/components/AiEngineStatus'));

function StatusPlaceholder() {
  return <span aria-hidden className="inline-flex h-8 w-24 rounded-full border border-line" />;
}

export function TopBar() {
  const navigate = useNavigate();
  const { alerts } = useNavBadges();
  const phone = useIsPhone();

  // Phones get a compact header (search behind an icon, status as a dot).
  if (phone) return <MobileHeader />;

  return (
    <header className="relative z-[1100] flex h-[52px] shrink-0 items-center gap-3 border-b border-line bg-surface px-3 lg:px-4">
      <GlobalPlateSearch />
      <div className="flex-1" />
      <Suspense fallback={null}>
        <AiEngineStatusPill className="shrink-0" />
      </Suspense>
      <div className="hidden md:block">
        <Suspense fallback={<StatusPlaceholder />}>
          <SystemStatus />
        </Suspense>
      </div>
      <LiveClock withDate className="hidden border-l border-line pl-3 lg:block" />
      <div className="flex items-center gap-1 border-l border-line pl-2">
        <IconButton
          label={alerts > 0 ? `Alerts: ${alerts} unacknowledged` : 'Alerts'}
          icon={<BellIcon size={18} strokeWidth={1.75} />}
          badge={alerts}
          onClick={() => navigate('/alerts')}
        />
        <ThemeToggle />
      </div>
      <UserMenu />
    </header>
  );
}
