// ═══════════════════════════════════════════════════
// Test helper: a fake Supabase client whose query builder is
// chainable + thenable. Each `from(table)` call pops the next
// queued response for that table, and every call is recorded so
// tests can assert on filters / ordering / payloads.
// A queued `Error` instance makes the query reject (network failure).
// ═══════════════════════════════════════════════════
import { vi } from 'vitest';

export interface FakeResponse {
  data?: unknown;
  error?: { message: string } | null;
}

export interface RecordedCall {
  table: string;
  ops: { method: string; args: unknown[] }[];
}

const CHAIN_METHODS = [
  'select', 'eq', 'order', 'limit', 'ilike', 'in', 'update', 'insert', 'single', 'maybeSingle',
];

export function createFakeSupabase() {
  const queues = new Map<string, (FakeResponse | Error)[]>();
  const calls: RecordedCall[] = [];

  const enqueue = (table: string, ...responses: (FakeResponse | Error)[]) => {
    const q = queues.get(table) ?? [];
    q.push(...responses);
    queues.set(table, q);
  };

  const reset = () => {
    queues.clear();
    calls.length = 0;
  };

  const from = vi.fn((table: string) => {
    const call: RecordedCall = { table, ops: [] };
    calls.push(call);
    const q = queues.get(table) ?? [];
    const response = q.length ? q.shift()! : { data: [], error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {};
    for (const m of CHAIN_METHODS) {
      builder[m] = (...args: unknown[]) => {
        call.ops.push({ method: m, args });
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (response instanceof Error) return Promise.reject(response).then(resolve, reject);
      return Promise.resolve({ data: response.data ?? null, error: response.error ?? null }).then(resolve, reject);
    };
    return builder;
  });

  const opsFor = (call: RecordedCall, method: string) =>
    call.ops.filter((o) => o.method === method).map((o) => o.args);

  return { client: { from }, enqueue, calls, from, reset, opsFor };
}
