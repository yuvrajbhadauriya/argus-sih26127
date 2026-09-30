// ═══════════════════════════════════════════════════
// Test helper: a fake /api/data server (src/lib/dataApi.ts talks to it via
// the global fetch). Each request to /api/data/<route> pops the next queued
// reply for that route (default: 200 { rows: [] }); every call is recorded so
// tests can assert on routes / params / payloads / auth headers.
// A queued `Error` makes fetch reject (network failure). Other URLs go to
// `passthrough` (e.g. a stub for static JSON) or answer 404.
//
//   const api = createFakeDataApi();
//   beforeEach(() => { api.reset(); vi.stubGlobal('fetch', api.fetch); });
//   api.enqueue('alerts', rows([...]), fail(502, 'Database request failed'));
// ═══════════════════════════════════════════════════
import { vi } from 'vitest';

export interface FakeApiReply {
  status?: number;
  body?: unknown;
}

export interface ApiCall {
  route: string;
  method: string;
  params: URLSearchParams;
  body: unknown;
  headers: Headers;
}

export const rows = (data: unknown[]): FakeApiReply => ({ body: { rows: data } });
export const row = (data: unknown): FakeApiReply => ({ body: { row: data } });
export const fail = (status: number, error: string): FakeApiReply => ({ status, body: { error } });

export function createFakeDataApi(passthrough?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const queues = new Map<string, (FakeApiReply | Error)[]>();
  const calls: ApiCall[] = [];

  const enqueue = (route: string, ...replies: (FakeApiReply | Error)[]) => {
    const q = queues.get(route) ?? [];
    q.push(...replies);
    queues.set(route, q);
  };

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost');
    if (!url.pathname.startsWith('/api/data/')) {
      return passthrough ? passthrough(input, init) : new Response('not found', { status: 404 });
    }
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const route = url.pathname.slice('/api/data/'.length);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ route, method: (init?.method ?? 'GET').toUpperCase(), params: url.searchParams, body, headers: new Headers(init?.headers) });
    const q = queues.get(route) ?? [];
    const reply = q.length ? q.shift()! : rows([]);
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? null), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });

  const reset = () => {
    queues.clear();
    calls.length = 0;
    fetch.mockClear();
  };

  const callsTo = (route: string) => calls.filter((c) => c.route === route);

  return { fetch, enqueue, reset, calls, callsTo };
}
