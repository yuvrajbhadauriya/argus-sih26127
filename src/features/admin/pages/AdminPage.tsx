// ═══════════════════════════════════════════════════
// AdminPage — Administration
// Camera registry, watchlist, users & roles, audit trail and system info.
// ═══════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CctvIcon,
  CpuIcon,
  PencilIcon,
  HistoryIcon,
  MapPinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShieldAlertIcon,
  UsersIcon,
} from 'lucide-react';
import type { AlertPriority, AuditLogEntry, BlacklistEntry, WatchlistCategory } from '@/types';
import type { Camera } from '@/types/camera';
import { DEFAULT_MAP_CENTER } from '@/config/constants';
import { useDataSource } from '@/lib/dataSource';
import { createCamera, fetchCameras, updateCamera } from '@/features/cameras/api';
import { clearCamerasCache } from '@/features/cameras/hooks/useCameras';
import { createWatchlistEntry, fetchBlacklistEntries, updateWatchlistEntry } from '@/features/alerts/api';
import { fetchAuditLog } from '@/features/admin/api';
import { ROLE_LABEL, useAuth } from '@/features/auth/session';
import { useOperatorAction } from '@/features/auth/guard';
import { DETECT_ENDPOINT } from '@/features/detections/remote/detectFrame';
import { formatIstDate, formatIstTime } from '@/features/vehicles/lib/geo';
import { mockUsers, type UserAccount } from '@/mocks/fixtures/mockAdmin';
import { Page, PageHeader } from '@/shared/layout/Page';
import { ThemeToggle } from '@/shared/layout/ThemeToggle';
import { Panel } from '@/shared/ui/Card';
import { Badge, type Tone } from '@/shared/ui/Badge';
import { Button, IconButton } from '@/shared/ui/Button';
import { DataTable, type Column } from '@/shared/ui/DataTable';
import { Field, Input, Select, Textarea, Toolbar } from '@/shared/ui/Input';
import { Modal } from '@/shared/ui/Modal';
import { PlateChip } from '@/shared/ui/PlateChip';
import { SeverityChip } from '@/shared/ui/SeverityChip';
import { StatusPill } from '@/shared/ui/StatusPill';
import { TabPanel, Tabs } from '@/shared/ui/Tabs';
import { EmptyState } from '@/shared/ui/EmptyState';
import { ErrorState } from '@/shared/ui/ErrorState';
import { toast } from '@/shared/ui/toast';
import { formatPlate, normalizePlate } from '@/shared/lib/plate';
import { cn } from '@/shared/lib/cn';

type AdminTab = 'cameras' | 'watchlist' | 'users' | 'audit' | 'system';

const ZONES = ['Island City', 'Western Suburbs', 'Eastern Suburbs'];
const DIRECTIONS = ['Northbound', 'Southbound', 'Eastbound', 'Westbound'];
const CATEGORIES: WatchlistCategory[] = ['stolen', 'wanted', 'missing', 'flagged', 'custom'];
const PRIORITIES: AlertPriority[] = ['critical', 'high', 'medium', 'low'];
const ROLE_TONE: Record<UserAccount['role'], Tone> = { admin: 'primary', operator: 'neutral', analyst: 'info' };
const CAMERA_CODE = /^[A-Z]{2}-\d{2}$/;
const PLATE = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$|^\d{2}BH\d{4}[A-Z]{1,2}$/;

const nowIso = () => new Date().toISOString();
const istStamp = (iso: string) => `${formatIstDate(iso)} ${formatIstTime(iso)}`;

// ── small building blocks ────────────────────────

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        checked ? 'border-primary-solid bg-primary-solid' : 'border-line-strong bg-surface-3',
      )}
    >
      <span
        aria-hidden
        className={cn('inline-block h-3.5 w-3.5 rounded-full bg-surface shadow-sm transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-[2px]')}
      />
    </button>
  );
}

interface CameraForm { name: string; code: string; zone: string; direction: string; road: string; lat: string; lng: string; status: Camera['status'] }
const EMPTY_CAMERA: CameraForm = {
  name: '', code: '', zone: ZONES[0], direction: DIRECTIONS[0], road: '',
  lat: DEFAULT_MAP_CENTER[0].toFixed(5), lng: DEFAULT_MAP_CENTER[1].toFixed(5), status: 'offline',
};
// Greater Mumbai bounding box (camera coordinates are validated against it).
const MUMBAI = { latMin: 18.85, latMax: 19.35, lngMin: 72.75, lngMax: 73.1 };
interface WatchForm { plate: string; category: WatchlistCategory; priority: AlertPriority; reason: string; validTo: string }
type Errors<T> = Partial<Record<keyof T, string>>;

// ── page ─────────────────────────────────────────

export function AdminPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<AdminTab>('cameras');
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [watchlist, setWatchlist] = useState<BlacklistEntry[]>([]);
  const [audit, setAudit] = useState<AuditLogEntry[]>([]);
  const [auditNote, setAuditNote] = useState<string | null>(null);
  const { user } = useAuth();
  const guard = useOperatorAction();
  const ds = useDataSource();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [camQuery, setCamQuery] = useState('');
  const [wlQuery, setWlQuery] = useState('');
  const [wlCategory, setWlCategory] = useState('all');
  const [auditUser, setAuditUser] = useState('all');
  const [auditDay, setAuditDay] = useState('all');

  const [camOpen, setCamOpen] = useState(false);
  const [camForm, setCamForm] = useState<CameraForm>(EMPTY_CAMERA);
  const [editingCam, setEditingCam] = useState<Camera | null>(null);
  const [saving, setSaving] = useState(false);
  const [camErrors, setCamErrors] = useState<Errors<CameraForm>>({});
  const [wlOpen, setWlOpen] = useState(false);
  const [wlForm, setWlForm] = useState<WatchForm>({ plate: '', category: 'stolen', priority: 'high', reason: '', validTo: '' });
  const [wlErrors, setWlErrors] = useState<Errors<WatchForm>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, w] = await Promise.all([fetchCameras(), fetchBlacklistEntries()]);
      setCameras(c);
      setWatchlist(w);
      fetchAuditLog()
        .then((a) => {
          setAudit(a);
          setAuditNote(null);
        })
        .catch((err: unknown) => {
          setAudit([]);
          setAuditNote(err instanceof Error ? err.message : 'Audit trail unavailable');
        });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load admin data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    load();
  }, [load]);

  // Live mode: the database audit trigger records writes (reloaded below);
  // simulated/demo mode keeps a session-local trail.
  const logAction = (action: string, entity_type: string, entity_id: string, details: string) => {
    if (ds.source === 'live') {
      fetchAuditLog().then(setAudit).catch(() => {});
      return;
    }
    setAudit((prev) => [
      { id: `aud-${Date.now()}`, action, entity_type, entity_id, user_id: user?.id ?? 'guest', user_email: user?.email ?? 'guest', details, timestamp: nowIso() },
      ...prev,
    ]);
  };

  const openRegister = () => guard('register cameras', () => {
    setEditingCam(null);
    setCamForm(EMPTY_CAMERA);
    setCamErrors({});
    setCamOpen(true);
  });

  const openEdit = (c: Camera) => guard('edit cameras', () => {
    setEditingCam(c);
    setCamForm({
      name: c.name, code: c.code, zone: c.zone, direction: c.direction, road: c.road ?? '',
      lat: c.latitude.toFixed(5), lng: c.longitude.toFixed(5), status: c.status,
    });
    setCamErrors({});
    setCamOpen(true);
  });

  // ── cameras ──
  const submitCamera = async (e: FormEvent) => {
    e.preventDefault();
    const code = camForm.code.trim().toUpperCase();
    const lat = Number(camForm.lat);
    const lng = Number(camForm.lng);
    const errs: Errors<CameraForm> = {};
    if (!camForm.name.trim()) errs.name = 'Enter a camera name.';
    if (!editingCam) {
      if (!CAMERA_CODE.test(code)) errs.code = 'Use the format AB-01.';
      else if (cameras.some((c) => c.code === code)) errs.code = `${code} is already registered.`;
    }
    if (!Number.isFinite(lat) || lat < MUMBAI.latMin || lat > MUMBAI.latMax) errs.lat = 'Latitude must be inside Greater Mumbai (18.85–19.35).';
    if (!Number.isFinite(lng) || lng < MUMBAI.lngMin || lng > MUMBAI.lngMax) errs.lng = 'Longitude must be inside Greater Mumbai (72.75–73.10).';
    setCamErrors(errs);
    if (Object.keys(errs).length) return;
    const fields = {
      name: camForm.name.trim(), zone: camForm.zone, direction: camForm.direction,
      road: camForm.road.trim() || undefined, latitude: lat, longitude: lng, status: camForm.status,
    };
    setSaving(true);
    try {
      if (editingCam) {
        await updateCamera(editingCam.id, fields);
        setCameras((prev) => prev.map((c) => (c.id === editingCam.id ? { ...c, ...fields } : c)));
        logAction('CAMERA_UPDATE', 'camera', editingCam.code, `Updated ${fields.name} (${editingCam.code})`);
        toast({ tone: 'success', title: 'Camera updated', description: `${editingCam.code} · ${fields.name}` });
      } else {
        const cam = await createCamera({ ...fields, code });
        setCameras((prev) => [cam, ...prev]);
        logAction('CAMERA_REGISTER', 'camera', code, `Registered ${cam.name} (${code}) in ${cam.zone}`);
        toast({ tone: 'success', title: 'Camera registered', description: `${code} · ${cam.name} — ${cam.status === 'online' ? 'online' : 'offline until its stream is connected'}` });
      }
      clearCamerasCache();
      setCamOpen(false);
      setCamForm(EMPTY_CAMERA);
      setEditingCam(null);
    } catch (err) {
      toast({ tone: 'danger', title: editingCam ? 'Could not update camera' : 'Could not register camera', description: err instanceof Error ? err.message : 'Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  // ── watchlist ──
  const submitWatch = async (e: FormEvent) => {
    e.preventDefault();
    const n = normalizePlate(wlForm.plate);
    const errs: Errors<WatchForm> = {};
    if (!PLATE.test(n)) errs.plate = 'Enter a valid Indian plate, e.g. MH 01 CS 0126.';
    else if (watchlist.some((w) => normalizePlate(w.plate_text) === n && w.is_active)) errs.plate = 'This plate is already on the active watchlist.';
    if (wlForm.reason.trim().length < 5) errs.reason = 'Give a short reason (at least 5 characters).';
    setWlErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    try {
      const entry = await createWatchlistEntry({
        plate_text: formatPlate(n),
        category: wlForm.category,
        priority: wlForm.priority,
        reason: wlForm.reason.trim(),
        valid_to: wlForm.validTo ? new Date(`${wlForm.validTo}T23:59:59+05:30`).toISOString() : null,
      });
      setWatchlist((prev) => [entry, ...prev.filter((w) => w.id !== entry.id)]);
      logAction('WATCHLIST_ADD', 'blacklist_entry', entry.id, `Added ${entry.priority} priority watchlist entry for ${entry.plate_text} (${entry.category})`);
      toast({ tone: 'success', title: 'Plate added to watchlist', description: `${entry.plate_text} · alerts will fire on the next camera read` });
      setWlOpen(false);
      setWlForm({ plate: '', category: 'stolen', priority: 'high', reason: '', validTo: '' });
    } catch (err) {
      toast({ tone: 'danger', title: 'Could not add plate', description: err instanceof Error ? err.message : 'Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = (entry: BlacklistEntry, active: boolean) =>
    guard('edit the watchlist', async () => {
      const before = watchlist;
      setWatchlist((prev) => prev.map((w) => (w.id === entry.id ? { ...w, is_active: active, updated_at: nowIso() } : w)));
      try {
        await updateWatchlistEntry(entry.id, { is_active: active });
        logAction(active ? 'WATCHLIST_ENABLE' : 'WATCHLIST_DISABLE', 'blacklist_entry', entry.id, `${active ? 'Re-activated' : 'Deactivated'} watchlist entry for ${formatPlate(entry.plate_text)}`);
        toast({ tone: 'info', title: active ? 'Watchlist entry activated' : 'Watchlist entry paused', description: formatPlate(entry.plate_text) });
      } catch (err) {
        setWatchlist(before);
        toast({ tone: 'danger', title: 'Could not update watchlist entry', description: err instanceof Error ? err.message : 'Please try again.' });
      }
    });

  // ── derived rows ──
  const camRows = useMemo(() => {
    const q = camQuery.trim().toLowerCase();
    return q ? cameras.filter((c) => [c.name, c.code, c.zone, c.road ?? ''].some((v) => v.toLowerCase().includes(q))) : cameras;
  }, [cameras, camQuery]);

  const wlRows = useMemo(() => {
    const q = normalizePlate(wlQuery);
    const text = wlQuery.trim().toLowerCase();
    return watchlist.filter((w) =>
      (wlCategory === 'all' || w.category === wlCategory) &&
      (!text || normalizePlate(w.plate_text).includes(q) || w.reason.toLowerCase().includes(text)));
  }, [watchlist, wlQuery, wlCategory]);

  const auditDays = useMemo(() => [...new Set(audit.map((a) => formatIstDate(a.timestamp)))], [audit]);
  const auditRows = useMemo(
    () => audit.filter((a) => (auditUser === 'all' || a.user_email === auditUser) && (auditDay === 'all' || formatIstDate(a.timestamp) === auditDay)),
    [audit, auditUser, auditDay],
  );

  const userName = (email: string) => mockUsers.find((u) => u.email === email)?.name ?? email;

  const camCols: Column<Camera>[] = [
    { key: 'name', header: 'Name', sortValue: (c) => c.name, cell: (c) => <span className="font-medium text-fg">{c.name}</span> },
    { key: 'code', header: 'Code', mono: true, width: '84px', sortValue: (c) => c.code, cell: (c) => c.code },
    { key: 'zone', header: 'Zone', sortValue: (c) => c.zone, cell: (c) => c.zone, hideBelow: 'sm' },
    { key: 'dir', header: 'Direction', cell: (c) => c.direction, hideBelow: 'md' },
    { key: 'road', header: 'Road', cell: (c) => <span className="text-fg-muted">{c.road ?? '—'}</span>, hideBelow: 'lg' },
    { key: 'status', header: 'Status', sortValue: (c) => c.status, cell: (c) => <StatusPill status={c.status} size="sm" /> },
    {
      key: 'act', header: <span className="sr-only">Actions</span>, align: 'right', width: '80px',
      cell: (c) => (
        <span className="inline-flex gap-0.5">
          <IconButton size="sm" label={`Edit ${c.code}`} icon={<PencilIcon size={14} />} onClick={() => openEdit(c)} />
          <IconButton size="sm" label={`Locate ${c.code} on map`} icon={<MapPinIcon size={14} />} onClick={() => navigate(`/?cam=${encodeURIComponent(c.code)}`)} />
        </span>
      ),
    },
  ];

  const wlCols: Column<BlacklistEntry>[] = [
    { key: 'plate', header: 'Plate', sortValue: (w) => normalizePlate(w.plate_text), cell: (w) => <PlateChip plate={w.plate_text} size="xs" to={`/vehicles?plate=${encodeURIComponent(w.plate_text)}`} /> },
    { key: 'cat', header: 'Category', sortValue: (w) => w.category, cell: (w) => <Badge className="uppercase tracking-[0.04em]">{w.category}</Badge> },
    { key: 'pri', header: 'Priority', sortValue: (w) => PRIORITIES.indexOf(w.priority), cell: (w) => <SeverityChip severity={w.priority} size="sm" /> },
    { key: 'reason', header: 'Reason', cell: (w) => <span className="line-clamp-1 text-fg" title={w.reason}>{w.reason}</span>, hideBelow: 'md' },
    {
      key: 'valid', header: 'Valid', mono: true, hideBelow: 'lg', sortValue: (w) => w.valid_from,
      cell: (w) => <span className="whitespace-nowrap text-fg-muted">{formatIstDate(w.valid_from)} – {w.valid_to ? formatIstDate(w.valid_to) : 'open'}</span>,
    },
    {
      key: 'active', header: 'Active', align: 'right', width: '72px', sortValue: (w) => (w.is_active ? 0 : 1),
      cell: (w) => <Switch checked={w.is_active} onChange={(v) => toggleActive(w, v)} label={`Watchlist entry ${formatPlate(w.plate_text)} active`} />,
    },
  ];

  const userCols: Column<UserAccount>[] = [
    { key: 'name', header: 'Name', sortValue: (u) => u.name, cell: (u) => <span className="font-medium text-fg">{u.name}</span> },
    { key: 'email', header: 'Email', mono: true, hideBelow: 'sm', cell: (u) => u.email },
    { key: 'role', header: 'Role', sortValue: (u) => u.role, cell: (u) => <Badge tone={ROLE_TONE[u.role]} className="capitalize">{u.role}</Badge> },
    { key: 'status', header: 'Status', cell: (u) => <StatusPill status={u.status === 'active' ? 'online' : 'idle'} label={u.status === 'active' ? 'Active' : 'Suspended'} size="sm" /> },
    { key: 'last', header: 'Last active', mono: true, align: 'right', sortValue: (u) => u.last_active, cell: (u) => <span className="text-fg-muted">{istStamp(u.last_active)}</span> },
  ];

  const auditCols: Column<AuditLogEntry>[] = [
    { key: 'ts', header: 'Timestamp (IST)', mono: true, width: '170px', sortValue: (a) => a.timestamp, cell: (a) => istStamp(a.timestamp) },
    { key: 'action', header: 'Action', cell: (a) => <Badge className="font-mono">{a.action}</Badge> },
    { key: 'user', header: 'User', hideBelow: 'sm', cell: (a) => userName(a.user_email) },
    { key: 'details', header: 'Details', cell: (a) => <span className="line-clamp-1 text-fg" title={a.details}>{a.details}</span> },
  ];

  const tabs = [
    { id: 'cameras', label: 'Cameras', icon: <CctvIcon size={16} strokeWidth={1.75} />, count: loading ? undefined : cameras.length },
    { id: 'watchlist', label: 'Watchlist', icon: <ShieldAlertIcon size={16} strokeWidth={1.75} />, count: loading ? undefined : watchlist.length },
    { id: 'users', label: 'Users & Roles', icon: <UsersIcon size={16} strokeWidth={1.75} />, count: mockUsers.length },
    { id: 'audit', label: 'Audit Log', icon: <HistoryIcon size={16} strokeWidth={1.75} />, count: audit.length },
    { id: 'system', label: 'System', icon: <CpuIcon size={16} strokeWidth={1.75} /> },
  ];

  const system: [string, React.ReactNode][] = [
    ['ANPR model', 'YOLOv7-tiny ANPR (plate detection + OCR)'],
    ['Detection endpoint', <span key="e" className="font-mono">{DETECT_ENDPOINT}</span>],
    ['Data source', `${ds.label} — ${ds.description}`],
    ['Signed in as', user ? `${user.name} (${user.email}) · ${ROLE_LABEL[user.role]}${user.demo ? ' · demo identity' : ''}` : 'Not signed in (read-only)'],
    ['Cameras registered', `${cameras.length} (${cameras.filter((c) => c.status === 'online').length} online)`],
    ['Road routing', 'OSRM road geometry between camera pairs'],
    ['Map tiles', 'Esri Canvas (light / dark) with reference labels'],
    ['Time zone', 'Asia/Kolkata (IST, UTC+05:30)'],
    ['Theme', <ThemeToggle key="t" variant="segmented" />],
  ];

  return (
    <Page>
      <PageHeader
        title="Administration"
        icon={SettingsIcon}
        description="Camera registry, watchlist, access roles and audit trail"
        meta={
          user ? (
            <Badge tone={user.role === 'admin' ? 'primary' : 'info'} size="md">{`${ROLE_LABEL[user.role]}${user.demo ? ' · demo' : ''}`}</Badge>
          ) : (
            <Badge tone="neutral" size="md">Read-only · sign in to edit</Badge>
          )
        }
      />

      <div>
        <Tabs items={tabs} value={tab} onChange={(id) => setTab(id as AdminTab)} ariaLabel="Administration sections" />

        {error && tab !== 'system' && tab !== 'users' && tab !== 'audit' ? (
          <div className="mt-4"><ErrorState message={error} onRetry={load} /></div>
        ) : null}

        <TabPanel id="cameras" active={tab === 'cameras' && !error} className="mt-4">
          <Panel
            title="Camera registry"
            subtitle="ANPR camera nodes on the city network"
            flush
            actions={<Button size="sm" variant="primary" icon={<PlusIcon size={14} />} onClick={openRegister}>Register camera</Button>}
          >
            <Toolbar className="border-b border-line px-4 py-2.5">
              <Input uiSize="sm" icon={<SearchIcon size={14} />} placeholder="Search name, code, zone, road" aria-label="Search cameras" value={camQuery} onChange={(e) => setCamQuery(e.target.value)} className="w-full max-w-xs" />
            </Toolbar>
            <DataTable
              caption="Registered cameras"
              columns={camCols}
              rows={camRows}
              rowKey={(c) => c.id}
              loading={loading}
              rowTone={(c) => (c.status === 'offline' ? 'danger' : null)}
              empty={<EmptyState compact icon={<CctvIcon size={20} />} title="No cameras found" description={camQuery ? 'No camera matches this search.' : 'Register a camera to get started.'} />}
            />
          </Panel>
        </TabPanel>

        <TabPanel id="watchlist" active={tab === 'watchlist' && !error} className="mt-4">
          <Panel
            title="Watchlist"
            subtitle="A camera read of an active plate raises an alert"
            flush
            actions={<Button size="sm" variant="primary" icon={<PlusIcon size={14} />} onClick={() => guard('edit the watchlist', () => { setWlErrors({}); setWlOpen(true); })}>Add plate</Button>}
          >
            <Toolbar className="border-b border-line px-4 py-2.5">
              <Input uiSize="sm" icon={<SearchIcon size={14} />} placeholder="Search plate or reason" aria-label="Search watchlist" value={wlQuery} onChange={(e) => setWlQuery(e.target.value)} className="w-full max-w-xs" />
              <Select uiSize="sm" label="Category" value={wlCategory} onChange={(e) => setWlCategory(e.target.value)} aria-label="Filter by category">
                <option value="all">All</option>
                {CATEGORIES.map((c) => <option key={c} value={c} className="capitalize">{c}</option>)}
              </Select>
            </Toolbar>
            <DataTable
              caption="Watchlist entries"
              columns={wlCols}
              rows={wlRows}
              rowKey={(w) => w.id}
              loading={loading}
              initialSort={{ key: 'pri', dir: 'asc' }}
              empty={<EmptyState compact icon={<ShieldAlertIcon size={20} />} title="No watchlist entries" description="No entry matches these filters." />}
            />
          </Panel>
        </TabPanel>

        <TabPanel id="users" active={tab === 'users'} className="mt-4">
          <Panel
            title="Users & roles"
            subtitle={ds.source === 'live'
              ? 'Sample directory — live roles are set in Supabase Auth (app_metadata.role), see docs/DATABASE.md'
              : 'Admins manage configuration · operators triage alerts · analysts read analytics'}
            flush
          >
            <DataTable caption="User accounts" columns={userCols} rows={mockUsers} rowKey={(u) => u.id} empty={<EmptyState compact title="No users" />} />
          </Panel>
        </TabPanel>

        <TabPanel id="audit" active={tab === 'audit'} className="mt-4">
          <Panel title="Audit log" subtitle="Every search, acknowledgement and configuration change" flush>
            <Toolbar className="border-b border-line px-4 py-2.5">
              <Select uiSize="sm" label="User" value={auditUser} onChange={(e) => setAuditUser(e.target.value)} aria-label="Filter by user">
                <option value="all">All users</option>
                {mockUsers.map((u) => <option key={u.id} value={u.email}>{u.name}</option>)}
              </Select>
              <Select uiSize="sm" label="Date" value={auditDay} onChange={(e) => setAuditDay(e.target.value)} aria-label="Filter by date">
                <option value="all">All dates</option>
                {auditDays.map((d) => <option key={d} value={d}>{d}</option>)}
              </Select>
            </Toolbar>
            <DataTable
              caption="Audit log"
              columns={auditCols}
              rows={auditRows}
              rowKey={(a) => a.id}
              pageSize={20}
              initialSort={{ key: 'ts', dir: 'desc' }}
              empty={<EmptyState compact icon={<HistoryIcon size={20} />} title="No audit entries" description={auditNote ?? (ds.source === 'live' && !user ? 'The audit trail is visible to signed-in operators and admins.' : 'Nothing recorded for these filters.')} />}
            />
          </Panel>
        </TabPanel>

        <TabPanel id="system" active={tab === 'system'} className="mt-4">
          <Panel title="System" subtitle="Prototype configuration" icon={<CpuIcon />}>
            <dl className="divide-y divide-line">
              {system.map(([k, v]) => (
                <div key={k} className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[200px_minmax(0,1fr)] sm:items-center">
                  <dt className="text-xs text-fg-muted">{k}</dt>
                  <dd className="text-[13px] text-fg">{v}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </TabPanel>
      </div>

      <Modal
        open={camOpen}
        onClose={() => setCamOpen(false)}
        title={editingCam ? `Edit camera ${editingCam.code}` : 'Register camera'}
        description={editingCam ? 'Changes apply to the live map and trajectory reconstruction.' : 'The camera appears offline until its video stream is connected.'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCamOpen(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="register-camera" loading={saving}>{editingCam ? 'Save changes' : 'Register camera'}</Button>
          </>
        }
      >
        <form id="register-camera" onSubmit={submitCamera} noValidate className="grid gap-3 sm:grid-cols-2">
          <Field label="Camera name" htmlFor="cam-name" required error={camErrors.name} className="sm:col-span-2">
            <Input id="cam-name" value={camForm.name} invalid={!!camErrors.name} onChange={(e) => setCamForm({ ...camForm, name: e.target.value })} placeholder="e.g. Andheri Flyover (WEH)" />
          </Field>
          <Field label="Code" htmlFor="cam-code" required error={camErrors.code} hint="Two letters, dash, two digits">
            <Input id="cam-code" mono value={camForm.code} invalid={!!camErrors.code} disabled={!!editingCam} onChange={(e) => setCamForm({ ...camForm, code: e.target.value.toUpperCase() })} placeholder="GK-01" />
          </Field>
          <Field label="Zone" htmlFor="cam-zone">
            <Select id="cam-zone" value={camForm.zone} onChange={(e) => setCamForm({ ...camForm, zone: e.target.value })} className="w-full">
              {ZONES.map((z) => <option key={z}>{z}</option>)}
            </Select>
          </Field>
          <Field label="Direction" htmlFor="cam-dir">
            <Select id="cam-dir" value={camForm.direction} onChange={(e) => setCamForm({ ...camForm, direction: e.target.value })} className="w-full">
              {DIRECTIONS.map((d) => <option key={d}>{d}</option>)}
            </Select>
          </Field>
          <Field label="Road / junction" htmlFor="cam-road">
            <Input id="cam-road" value={camForm.road} onChange={(e) => setCamForm({ ...camForm, road: e.target.value })} placeholder="e.g. LBS Marg at Ghatkopar" />
          </Field>
          <Field label="Status" htmlFor="cam-status">
            <Select id="cam-status" value={camForm.status} onChange={(e) => setCamForm({ ...camForm, status: e.target.value as Camera['status'] })} className="w-full">
              <option value="offline">Offline</option>
              <option value="online">Online</option>
            </Select>
          </Field>
          <Field label="Latitude" htmlFor="cam-lat" required error={camErrors.lat}>
            <Input id="cam-lat" mono inputMode="decimal" value={camForm.lat} invalid={!!camErrors.lat} onChange={(e) => setCamForm({ ...camForm, lat: e.target.value })} />
          </Field>
          <Field label="Longitude" htmlFor="cam-lng" required error={camErrors.lng}>
            <Input id="cam-lng" mono inputMode="decimal" value={camForm.lng} invalid={!!camErrors.lng} onChange={(e) => setCamForm({ ...camForm, lng: e.target.value })} />
          </Field>
        </form>
      </Modal>

      <Modal
        open={wlOpen}
        onClose={() => setWlOpen(false)}
        title="Add plate to watchlist"
        description="Every camera read of this plate will raise an alert for the duty officer."
        footer={
          <>
            <Button variant="ghost" onClick={() => setWlOpen(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="add-watchlist" loading={saving}>Add to watchlist</Button>
          </>
        }
      >
        <form id="add-watchlist" onSubmit={submitWatch} noValidate className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Plate number"
            htmlFor="wl-plate"
            required
            error={wlErrors.plate}
            className="sm:col-span-2"
            hint={wlForm.plate.trim() ? <span className="inline-flex items-center gap-2">Preview <PlateChip plate={wlForm.plate} size="sm" /></span> : 'Spaces and dashes are optional'}
          >
            <Input id="wl-plate" mono value={wlForm.plate} invalid={!!wlErrors.plate} onChange={(e) => setWlForm({ ...wlForm, plate: e.target.value.toUpperCase() })} placeholder="MH 01 CS 0126" className="[&_input]:uppercase" />
          </Field>
          <Field label="Category" htmlFor="wl-cat">
            <Select id="wl-cat" value={wlForm.category} onChange={(e) => setWlForm({ ...wlForm, category: e.target.value as WatchlistCategory })} className="w-full">
              {CATEGORIES.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
            </Select>
          </Field>
          <Field label="Priority" htmlFor="wl-pri">
            <Select id="wl-pri" value={wlForm.priority} onChange={(e) => setWlForm({ ...wlForm, priority: e.target.value as AlertPriority })} className="w-full">
              {PRIORITIES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
            </Select>
          </Field>
          <Field label="Reason" htmlFor="wl-reason" required error={wlErrors.reason} className="sm:col-span-2">
            <Textarea id="wl-reason" value={wlForm.reason} invalid={!!wlErrors.reason} onChange={(e) => setWlForm({ ...wlForm, reason: e.target.value })} placeholder="e.g. Reported stolen, FIR 1234/2026" />
          </Field>
          <Field label="Valid until" htmlFor="wl-valid" hint="Leave empty for no expiry">
            <Input id="wl-valid" type="date" value={wlForm.validTo} onChange={(e) => setWlForm({ ...wlForm, validTo: e.target.value })} />
          </Field>
        </form>
      </Modal>
    </Page>
  );
}

export default AdminPage;
