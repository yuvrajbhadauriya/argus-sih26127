// ═══════════════════════════════════════════════════
// toast — tiny external store (no Provider). <Toaster/> renders it.
// ═══════════════════════════════════════════════════

export type ToastTone = 'success' | 'danger' | 'warning' | 'info';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  durationMs?: number;
}

export interface ToastItem extends Required<Pick<ToastInput, 'title' | 'tone' | 'durationMs'>> {
  id: number;
  description?: string;
}

const MAX_VISIBLE = 3;
let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  listeners.forEach((l) => l());
}

export function dismissToast(id: number): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  const next = items.filter((i) => i.id !== id);
  if (next.length !== items.length) {
    items = next;
    emit();
  }
}

export function toast(t: ToastInput): void {
  const item: ToastItem = {
    id: nextId++,
    title: t.title,
    description: t.description,
    tone: t.tone ?? 'info',
    durationMs: t.durationMs ?? 4000,
  };
  items = [...items, item].slice(-MAX_VISIBLE);
  if (item.durationMs > 0) timers.set(item.id, setTimeout(() => dismissToast(item.id), item.durationMs));
  emit();
}

export function subscribeToasts(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getToasts(): ToastItem[] {
  return items;
}

/** Clear all toasts (tests). */
export function clearToasts(): void {
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
  items = [];
  emit();
}
