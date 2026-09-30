// ═══════════════════════════════════════════════════════════════════════
// /api/data/* — one serverless function for every dashboard data route.
//
// vercel.json rewrites /api/data/<route> → /api/data?path=<route>, so all
// routes share one function (one cold start, well under the plan's function
// limit). The route table, auth and caching live in ../_lib/dataRoutes.ts;
// `npm run dev` serves the same handler through api/_lib/viteDevBridge.ts.
// ═══════════════════════════════════════════════════════════════════════

import { handleData } from '../_lib/dataRoutes.js';

const handler = (request: Request) => handleData(request);

export const GET = handler;
export const HEAD = handler;
export const POST = handler;
export const PATCH = handler;
export const OPTIONS = handler;
