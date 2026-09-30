// ═══════════════════════════════════════════════════════════════════════
// Dev-only bridge: serves the /api functions (detect, health, data/*,
// media/sign) from `npm run dev`.
//
// Plain `vite` has no serverless functions, so the Live-detect panel had no
// backend locally. This Vite plugin (apply: 'serve', never part of a build)
// mounts the SAME handlers Vercel runs (api/detect.ts, api/health.ts,
// api/data → api/_lib/dataRoutes.ts, api/media/sign.ts) as dev-server
// middleware:
//
//   - /api/media/sign (signed URLs for the private Storage buckets) is mounted
//     too; it gets SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY the same way.
//   - The model API config is read server-side with Vite's loadEnv(mode, root, '')
//     from .env / .env.local, keeping only DETECTION_API_* / ANPR_API_* keys and
//     SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (server-only), and
//     passed to the handlers as `deps.env`. Nothing is `define`d or exposed via
//     import.meta.env — only VITE_* keys ever reach the browser bundle, and
//     these keys must never be renamed to VITE_*.
//   - Requests are only served to loopback clients (the dev server may be
//     started with --host); set NERO_DEV_API_ALLOW_LAN=1 to lift that.
//   - Handlers are loaded with ssrLoadModule, so edits hot-reload.
//
// The GPU model API itself is LAN/Tailscale-only (DPDP): never expose it
// through a public tunnel. On Vercel the env is unset and /api/detect answers
// 503 "model API is LAN/VPN-only".
// ═══════════════════════════════════════════════════════════════════════

import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv, type Plugin, type ViteDevServer } from 'vite';

type Handler = (request: Request, deps: { env: Record<string, string | undefined> }) => Promise<Response>;

const ROUTES: Record<string, { module: string; handler: string }> = {
  '/api/detect': { module: '/api/detect.ts', handler: 'handleDetect' },
  '/api/health': { module: '/api/health.ts', handler: 'handleHealth' },
  '/api/media/sign': { module: '/api/media/sign.ts', handler: 'handleSign' },
  // Every /api/data/<route> (see api/data/index.ts and the vercel.json rewrite).
  '/api/data': { module: '/api/_lib/dataRoutes.ts', handler: 'handleData' },
};

/** Route for a request path (/api/data/<anything> → the data handler). */
export function matchRoute(pathname: string): { module: string; handler: string } | undefined {
  const p = pathname.replace(/\/+$/, '');
  return ROUTES[p] ?? (p.startsWith('/api/data/') ? ROUTES['/api/data'] : undefined);
}

/** Only these env keys are handed to the handlers (Supabase ones for /api/data and /api/media/sign). */
export const SERVER_ENV_KEY = /^(DETECTION_API_|ANPR_API_|SUPABASE_URL$|SUPABASE_SERVICE_ROLE_KEY$)/;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export function pickServerEnv(all: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(all).filter(([k]) => SERVER_ENV_KEY.test(k)));
}

function isLoopback(addr: string | undefined): boolean {
  return !!addr && (addr === '::1' || addr.startsWith('127.') || addr === '::ffff:127.0.0.1');
}

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const method = (req.method || 'GET').toUpperCase();
  let body: Uint8Array | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { status: 413 });
      chunks.push(chunk as Buffer);
    }
    body = new Uint8Array(Buffer.concat(chunks));
  }
  return new Request(`http://localhost${req.url ?? '/'}`, { method, headers, body: body as RequestInit['body'] });
}

async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function apiDevBridge(): Plugin {
  return {
    name: 'nero-api-dev-bridge',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      if (process.env.VITEST) return; // unit tests call the handlers directly
      const fileEnv = loadEnv(server.config.mode, server.config.envDir || server.config.root, '');
      const env = pickServerEnv({ ...fileEnv, ...process.env });
      const allowLan = process.env.NERO_DEV_API_ALLOW_LAN === '1';

      server.middlewares.use(async (req, res, next) => {
        const route = matchRoute((req.url ?? '').split('?')[0]);
        if (!route) return next();
        if (!allowLan && !isLoopback(req.socket.remoteAddress)) {
          return sendJson(res, 403, { error: 'Dev API bridge only serves localhost (set NERO_DEV_API_ALLOW_LAN=1)' });
        }
        try {
          const mod = (await server.ssrLoadModule(route.module)) as Record<string, Handler>;
          const response = await mod[route.handler](await toWebRequest(req), { env });
          await sendWebResponse(res, response);
        } catch (err) {
          const status = (err as { status?: number }).status === 413 ? 413 : 500;
          server.config.logger.error(`[api-dev-bridge] ${route.module}: ${err instanceof Error ? err.message : String(err)}`);
          sendJson(res, status, { error: status === 413 ? 'Request body too large' : 'Dev API bridge failed' });
        }
      });
    },
  };
}
