// ═══════════════════════════════════════════════════
// LoginPage — operator sign-in (/login), outside the dashboard shell.
// Live: Supabase Auth email + password. Demo (no Supabase): pick a clearly
// labelled demo identity. ?next=/path returns there after sign-in.
// ═══════════════════════════════════════════════════

import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeftIcon, FlaskConicalIcon, KeyRoundIcon, LockIcon, LogInIcon, MailIcon, ShieldCheckIcon, UserCogIcon } from 'lucide-react';
import { NeroMark } from '@/shared/layout/NeroMark';
import { ThemeToggle } from '@/shared/layout/ThemeToggle';
import { Button } from '@/shared/ui/Button';
import { Badge } from '@/shared/ui/Badge';
import { Field, Input } from '@/shared/ui/Input';
import { toast } from '@/shared/ui/toast';
import { DATA_SOURCE_LABEL, getDataSource } from '@/lib/dataSource';
import { safeNext } from './guard';
import { ROLE_LABEL, signInDemo, signInWithPassword, signOut, useAuth, type AuthUser } from './session';

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  const { mode, user, status } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const done = (u: AuthUser) => {
    toast({ tone: 'success', title: `Signed in as ${u.name}`, description: `${ROLE_LABEL[u.role]}${u.demo ? ' · demo identity' : ''}` });
    navigate(next, { replace: true });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      done(await signInWithPassword(email, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const demo = mode === 'demo';

  return (
    <div className="flex min-h-dvh w-full flex-col bg-canvas text-fg">
      <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-line bg-surface px-4">
        <Link to="/" className="flex items-center gap-2.5 rounded-sm focus-visible:outline-2 focus-visible:outline-focus">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-sm bg-primary/12 text-primary">
            <NeroMark size={16} />
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-bold tracking-[0.08em]">NERO</span>
            <span className="block text-2xs text-fg-subtle">City ANPR Intelligence</span>
          </span>
        </Link>
        <ThemeToggle />
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-[400px]">
          <div className="rounded-md border border-line bg-surface p-6 shadow-pop">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <h1 className="text-lg font-semibold">Operator sign-in</h1>
                <p className="mt-1 text-xs text-fg-muted">Control-room access for acknowledging alerts and managing the camera network and watchlist.</p>
              </div>
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
                <ShieldCheckIcon size={18} strokeWidth={1.75} aria-hidden />
              </span>
            </div>

            {user && status === 'ready' ? (
              <div className="space-y-4">
                <div className="rounded-sm border border-line bg-surface-2 px-3 py-2.5 text-[13px]">
                  Signed in as <span className="font-medium">{user.name}</span>{' '}
                  <span className="text-fg-muted">({user.email})</span>
                  <div className="mt-1.5 flex gap-1.5">
                    <Badge tone="primary">{ROLE_LABEL[user.role]}</Badge>
                    {user.demo && <Badge tone="warning">Demo identity</Badge>}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="primary" fullWidth onClick={() => navigate(next, { replace: true })}>Continue</Button>
                  <Button variant="secondary" onClick={() => void signOut()}>Sign out</Button>
                </div>
              </div>
            ) : demo ? (
              <div className="space-y-4">
                <div role="note" className="flex gap-2.5 rounded-sm border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs text-fg">
                  <FlaskConicalIcon size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                  <p>
                    <span className="font-semibold">Demo mode.</span> No Supabase project is configured (VITE_SUPABASE_URL), so there is no real
                    authentication. Use a demo identity; changes stay in this browser session.
                  </p>
                </div>
                <Button variant="primary" fullWidth icon={<LogInIcon size={14} />} onClick={() => done(signInDemo('operator'))} data-autofocus>
                  Continue as Demo Operator
                </Button>
                <Button variant="secondary" fullWidth icon={<UserCogIcon size={14} />} onClick={() => done(signInDemo('admin'))}>
                  Continue as Demo Admin
                </Button>
              </div>
            ) : (
              <form onSubmit={submit} noValidate className="space-y-3.5">
                <Field label="Email" htmlFor="login-email" required>
                  <Input
                    id="login-email"
                    type="email"
                    autoComplete="username"
                    icon={<MailIcon />}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="operator@city.gov.in"
                    invalid={!!error}
                    autoFocus
                  />
                </Field>
                <Field label="Password" htmlFor="login-password" required>
                  <Input
                    id="login-password"
                    type="password"
                    autoComplete="current-password"
                    icon={<LockIcon />}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    invalid={!!error}
                  />
                </Field>
                {error && (
                  <p role="alert" className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                    {error}
                  </p>
                )}
                <Button type="submit" variant="primary" fullWidth loading={busy || status === 'loading'} icon={<KeyRoundIcon size={14} />}>
                  Sign in
                </Button>
                <p className="text-2xs text-fg-subtle">
                  Roles are assigned by an administrator (Supabase <span className="font-mono">app_metadata.role</span>: operator or admin).
                </p>
              </form>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between text-xs text-fg-muted">
            <Link to={next} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              <ArrowLeftIcon size={14} aria-hidden /> Continue without signing in (read-only)
            </Link>
            <span title="Data source">{DATA_SOURCE_LABEL[getDataSource()]}</span>
          </div>
        </div>
      </main>

      <footer className="border-t border-line px-4 py-3 text-center text-2xs text-fg-subtle">SIH 2026 · PS SIH26127 · Prototype</footer>
    </div>
  );
}

export default LoginPage;
