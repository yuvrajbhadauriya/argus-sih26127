// ═══════════════════════════════════════════════════
// Data Access Layer — Alerts & Watchlist
//
// Live (Supabase configured): reads/writes the `alerts` and
// `blacklist_entries` tables. Errors are thrown (pages show ErrorState) —
// never silently replaced by fixtures. Writes need a signed-in operator
// (RLS, see supabase/migrations/20261001000100_rls.sql).
//
// Simulated / demo: the alert feed generated from the simulated Mumbai network
// (src/mocks/fixtures/mockAlerts.ts). While "replay the day" is running
// (src/features/replay) only alerts that have fired by the replay clock are
// returned, so the queue fills up live.
// ═══════════════════════════════════════════════════

import type { AlertRecord, BlacklistEntry, AlertPriority, WatchlistCategory } from '@/types';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase/client';
import { reportLiveError, reportLiveOk } from '@/lib/dataSource';
import { DEFAULT_LOCATION } from '@/config/constants';
import { mockAlertFeed as mockAlerts, mockBlacklistEntries } from '@/mocks/fixtures/mockAlerts';
import { getReplayClock } from '@/features/replay/clock';
import type { TriageAlert } from './types';

/** Alerts acknowledged by the operator in this (non-live) session. */
const demoAcks = new Set<string>();

/**
 * Live mode with an empty `alerts` table: the simulated feed is shown instead
 * (tagged `simulated`, pages show the SimulationBadge). Set by fetchAlerts so
 * acknowledging one of those alerts stays local instead of hitting the DB.
 */
let liveFallbackActive = false;

/** True while live mode is showing the simulated alert feed (empty table). */
export function isAlertFallbackActive(): boolean {
  return liveFallbackActive;
}

/** Watchlist fallback flag (live mode, empty `blacklist_entries`). */
let watchlistFallbackActive = false;

export function isWatchlistFallbackActive(): boolean {
  return watchlistFallbackActive;
}

/**
 * The simulated feed as seen at replay time `clock`: alerts that have not fired
 * yet are hidden, and acknowledgements that happen later in the day are undone.
 */
export function simAlertsAt(clock: number | null, feed: TriageAlert[] = mockAlerts): TriageAlert[] {
  if (clock == null) return feed;
  return feed
    .filter((a) => Date.parse(a.timestamp) <= clock)
    .map((a) => {
      if (demoAcks.has(a.id) || !a.acknowledged) return a;
      const ackAt = a.acknowledged_at ? Date.parse(a.acknowledged_at) : Number.POSITIVE_INFINITY;
      return ackAt <= clock ? a : { ...a, acknowledged: false, acknowledged_by: undefined, acknowledged_at: undefined };
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const num = (...vals: any[]): number | undefined => vals.find((v) => typeof v === 'number' && Number.isFinite(v));

/** Map an `alerts` row (optionally with embedded detections → cameras and blacklist_entries). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToAlert(a: any): TriageAlert {
  const det = a.detections || {};
  const cam = det.cameras || {};
  const bl = a.blacklist_entries || {};
  const details = a.details && typeof a.details === 'object' ? a.details : {};
  const status = a.status ?? (a.acknowledged ? 'acknowledged' : 'open');
  const kind = a.alert_type === 'cloned_plate' || a.alert_type === 'circling' ? a.alert_type : undefined;
  return {
    id: a.id,
    detection_event_id: a.detection_id || a.detection_event_id || det.event_id || a.id,
    blacklist_entry_id: a.blacklist_entry_id || bl.id || '',
    plate_text: det.plate_text_raw || a.plate_text || bl.plate_text || bl.plate_text_normalized || details.plate_text || 'UNKNOWN',
    camera_id: det.camera_id || a.camera_id || details.camera_id || '',
    camera_name: cam.name || a.camera_name || details.camera_name || 'Unknown camera',
    priority: (bl.priority || a.priority || details.priority || 'high') as AlertPriority,
    category: (bl.category || a.category || details.category || 'stolen') as WatchlistCategory,
    reason: bl.notes || bl.reason || a.reason || details.reason || 'Watchlist plate read by camera ANPR',
    timestamp: a.created_at || a.timestamp || det.detected_at || new Date().toISOString(),
    lat: num(det.latitude, det.lat, cam.latitude, cam.lat, a.lat) ?? DEFAULT_LOCATION.lat,
    lng: num(det.longitude, det.lng, cam.longitude, cam.lng, a.lng) ?? DEFAULT_LOCATION.lng,
    acknowledged: status === 'acknowledged' || status === 'dismissed',
    acknowledged_by: a.acknowledged_by ?? undefined,
    acknowledged_at: a.acknowledged_at ?? undefined,
    ...(kind ? { kind } : {}),
    ...(cam.code ? { camera_code: cam.code } : {}),
  };
}

/** Embedded select used by the list and by realtime refetches. */
export const ALERT_SELECT = '*, detections(*, cameras(*)), blacklist_entries(*)';

/** Fetch all alerts, newest first (see module comment for sources). */
export async function fetchAlerts(): Promise<AlertRecord[]> {
  if (!isSupabaseConfigured()) {
    return simAlertsAt(getReplayClock());
  }

  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase.from('alerts').select(ALERT_SELECT).order('created_at', { ascending: false });

    if (!error && data && data.length > 0) {
      reportLiveOk();
      liveFallbackActive = false;
      return data.map(rowToAlert);
    }

    // Embedding can fail on a partially migrated schema: retry without joins.
    const { data: rawAlerts, error: rawErr } = await supabase.from('alerts').select('*').order('created_at', { ascending: false });
    if (rawErr) throw new Error(`Failed to load alerts: ${rawErr.message}`);
    reportLiveOk();
    if (rawAlerts && rawAlerts.length > 0) {
      liveFallbackActive = false;
      return rawAlerts.map(rowToAlert);
    }
    // Connected but nothing recorded yet: show the simulated network's feed
    // (labelled) rather than an empty control room.
    liveFallbackActive = true;
    return simAlertsAt(getReplayClock()).map((a) => ({ ...a, simulated: true }));
  } catch (err) {
    reportLiveError(err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Fetch one alert (with joins) by id — used by the realtime subscription. */
export async function fetchAlertById(id: string): Promise<TriageAlert | null> {
  if (!isSupabaseConfigured() || (liveFallbackActive && mockAlerts.some((a) => a.id === id))) return (mockAlerts.find((a) => a.id === id) as TriageAlert | undefined) ?? null;
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('alerts').select(ALERT_SELECT).eq('id', id).maybeSingle();
  if (error) throw new Error(`Failed to load alert: ${error.message}`);
  return data ? rowToAlert(data) : null;
}

/**
 * Acknowledge an alert. Live: needs an operator session (RLS); the server
 * stamps acknowledged_by/at from the JWT, the name sent here is informative.
 */
export async function acknowledgeAlert(alertId: string, operatorName: string = 'Admin'): Promise<void> {
  const simulatedAlert = liveFallbackActive && mockAlerts.some((a) => a.id === alertId);
  if (!isSupabaseConfigured() || simulatedAlert) {
    const alert = mockAlerts.find((a) => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      alert.acknowledged_by = operatorName;
      alert.acknowledged_at = new Date().toISOString();
      demoAcks.add(alertId);
    }
    return;
  }

  const supabase = await getSupabase();
  const { error } = await supabase
    .from('alerts')
    .update({
      status: 'acknowledged',
      acknowledged: true,
      acknowledged_by: operatorName,
      acknowledged_at: new Date().toISOString(),
    })
    .eq('id', alertId);

  if (error) throw new Error(`Failed to acknowledge alert: ${error.message}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEntry(row: any): BlacklistEntry {
  return {
    id: row.id,
    plate_text: row.plate_text || row.plate_text_normalized,
    category: row.category || 'stolen',
    priority: row.priority || 'high',
    reason: row.notes || row.reason || 'Watchlist target',
    valid_from: row.valid_from || row.created_at,
    valid_to: row.valid_to || null,
    is_active: row.is_active ?? true,
    created_at: row.created_at,
    updated_at: row.updated_at || row.created_at,
  };
}

/** Fetch all blacklist/watchlist entries */
export async function fetchBlacklistEntries(): Promise<BlacklistEntry[]> {
  if (!isSupabaseConfigured()) {
    return mockBlacklistEntries;
  }

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('blacklist_entries')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    reportLiveError(error.message);
    throw new Error(`Failed to fetch blacklist entries: ${error.message}`);
  }
  if (!data || data.length === 0) {
    // Empty table: the simulated network's watchlist (pages show the badge).
    watchlistFallbackActive = true;
    return mockBlacklistEntries;
  }
  watchlistFallbackActive = false;
  return data.map(rowToEntry);
}

export interface NewWatchlistEntry {
  plate_text: string;
  category: WatchlistCategory;
  priority: AlertPriority;
  reason: string;
  valid_to: string | null;
}

/** Add a plate to the watchlist (live: needs operator/admin). Returns the stored entry. */
export async function createWatchlistEntry(input: NewWatchlistEntry): Promise<BlacklistEntry> {
  const ts = new Date().toISOString();
  if (!isSupabaseConfigured()) {
    const entry: BlacklistEntry = { id: `bl-${Date.now()}`, ...input, valid_from: ts, is_active: true, created_at: ts, updated_at: ts };
    mockBlacklistEntries.unshift(entry);
    return entry;
  }
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('blacklist_entries')
    .insert({
      id: `bl-${crypto.randomUUID()}`,
      plate_text: input.plate_text,
      category: input.category,
      priority: input.priority,
      reason: input.reason,
      notes: input.reason,
      valid_from: ts,
      valid_to: input.valid_to,
      is_active: true,
      source: 'dashboard',
    })
    .select('*')
    .single();
  if (error) throw new Error(`Failed to add watchlist entry: ${error.message}`);
  return rowToEntry(data);
}

/** Edit a watchlist entry (active flag, priority, reason, validity). */
export async function updateWatchlistEntry(
  id: string,
  patch: Partial<Pick<BlacklistEntry, 'is_active' | 'priority' | 'category' | 'reason' | 'valid_to'>>,
): Promise<void> {
  const ts = new Date().toISOString();
  if (!isSupabaseConfigured()) {
    const e = mockBlacklistEntries.find((w) => w.id === id);
    if (e) Object.assign(e, patch, { updated_at: ts });
    return;
  }
  const supabase = await getSupabase();
  const row: Record<string, unknown> = { ...patch, updated_at: ts };
  if (patch.reason !== undefined) row.notes = patch.reason;
  if (watchlistFallbackActive && mockBlacklistEntries.some((w) => w.id === id)) {
    const e = mockBlacklistEntries.find((w) => w.id === id)!;
    Object.assign(e, patch, { updated_at: ts });
    return;
  }
  const { error } = await supabase.from('blacklist_entries').update(row).eq('id', id);
  if (error) throw new Error(`Failed to update watchlist entry: ${error.message}`);
}
