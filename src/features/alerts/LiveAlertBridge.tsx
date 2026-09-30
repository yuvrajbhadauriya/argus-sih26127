// ═══════════════════════════════════════════════════
// LiveAlertBridge — mounted once in the dashboard shell (lazily).
//
//  * Live mode: opens the Supabase Realtime subscription on `alerts`.
//  * Simulated mode: starts the replay engine (alerts fire as the replay
//    clock passes them).
//  * Either way: every new alert becomes a toast and refreshes the sidebar /
//    top-bar badge. The 30 s badge poll (useNavBadges) is the fallback.
// Renders nothing.
// ═══════════════════════════════════════════════════

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { isSupabaseConfigured } from '@/lib/supabase/client';
import { toast } from '@/shared/ui/toast';
import { refreshNavBadges } from '@/shared/layout/useNavBadges';
import { startReplayEngine } from '@/features/replay/engine';
import { subscribeReplay } from '@/features/replay/clock';
import { subscribeAlertEvents, setLiveChannelStatus } from './live';
import { subscribeAlertsRealtime } from './realtime';
import { alertToastContent } from './lib/toastContent';

export function LiveAlertBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    const stops: (() => void)[] = [];
    if (isSupabaseConfigured()) {
      stops.push(subscribeAlertsRealtime(setLiveChannelStatus));
    } else {
      stops.push(startReplayEngine());
      // Starting / stopping / seeking the replay changes which alerts exist.
      stops.push(subscribeReplay((prev, next, change) => {
        if (change !== 'tick' && (prev.active !== next.active || prev.clock !== next.clock)) void refreshNavBadges();
      }));
    }
    stops.push(
      subscribeAlertEvents((e) => {
        void refreshNavBadges();
        if (e.type !== 'insert') return;
        toast({
          ...alertToastContent(e),
          durationMs: 7000,
          action: { label: 'Open alert', onClick: () => navigate(`/alerts?id=${encodeURIComponent(e.alert.id)}`) },
        });
      }),
    );
    return () => stops.forEach((s) => s());
  }, [navigate]);

  return null;
}

export default LiveAlertBridge;
