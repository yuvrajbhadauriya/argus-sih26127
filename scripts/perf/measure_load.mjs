#!/usr/bin/env node
// ═══════════════════════════════════════════════════
// measure_load.mjs — cold-load timing + transferred bytes per route
//
// Usage:
//   npm run build && npx vite preview --port 4173 &
//   node scripts/perf/measure_load.mjs [baseUrl]
//
// Needs `playwright-core` resolvable (e.g. `npm i -D playwright-core` or run
// from a folder where it is installed) and a Chromium binary; set CHROME_PATH
// to override (defaults to the Playwright headless shell cache on macOS).
// Two profiles: "fast" (no throttling) and "slow4g" (Lighthouse mobile
// defaults: 1.6 Mbps down / 750 kbps up / 150 ms RTT, 4x CPU slowdown).
// ═══════════════════════════════════════════════════

import { createRequire } from 'node:module';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const require = createRequire(join(process.cwd(), 'noop.js'));
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  ({ chromium } = await import('playwright-core'));
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse();
  for (const d of dirs) {
    for (const arch of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64']) {
      const p = join(cache, d, arch, 'chrome-headless-shell');
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const BASE = process.argv[2] || 'http://localhost:4173';
const ONLY = process.env.ROUTES?.split(',');
const ROUTES = [
  { path: '/', ready: '.leaflet-container' },
  { path: '/cameras', ready: 'text=Camera Feeds', clickFirstCard: true },
  { path: '/analytics', ready: 'main h1, main h2' },
].filter((r) => !ONLY || ONLY.includes(r.path));
const PROFILES = {
  fast: null,
  slow4g: { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, cpu: 4 },
};

function kb(n) {
  return `${(n / 1024).toFixed(1)} kB`;
}

async function measure(browser, route, profileName) {
  const profile = PROFILES[profileName];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (profile) {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: profile.latency,
      downloadThroughput: profile.downloadThroughput,
      uploadThroughput: profile.uploadThroughput,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  }

  const reqs = new Map();
  cdp.on('Network.responseReceived', (e) => {
    reqs.set(e.requestId, { url: e.response.url, type: e.type, bytes: 0 });
  });
  cdp.on('Network.loadingFinished', (e) => {
    const r = reqs.get(e.requestId);
    if (r) r.bytes = e.encodedDataLength;
  });
  cdp.on('Network.dataReceived', (e) => {
    const r = reqs.get(e.requestId);
    if (r && r.type === 'Media') r.bytes += e.encodedDataLength || e.dataLength;
  });

  const t0 = Date.now();
  await page.goto(BASE + route.path, { waitUntil: 'commit' });
  await page.waitForSelector(route.ready, { timeout: 60000 });
  const readyMs = Date.now() - t0;
  const fcp = await page.evaluate(
    () => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
  );
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    return n ? { dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd } : null;
  });
  // let lazy stuff settle for a bit
  await page.waitForTimeout(profile ? 4000 : 1500);

  let afterClick = null;
  if (route.clickFirstCard) {
    const before = [...reqs.values()].reduce((s, r) => s + r.bytes, 0);
    const card = page.getByText('IG-01', { exact: true }).first();
    if (await card.count()) {
      await card.click();
      await page.waitForTimeout(5000);
      const after = [...reqs.values()];
      afterClick = {
        bytes: after.reduce((s, r) => s + r.bytes, 0) - before,
        videos: new Set(after.filter((r) => r.type === 'Media').map((r) => r.url)).size,
        detectionsBytes: after.filter((r) => r.url.includes('/detections/')).reduce((s, r) => s + r.bytes, 0),
      };
    }
  }

  const all = [...reqs.values()];
  const sum = (f) => all.filter(f).reduce((s, r) => s + r.bytes, 0);
  const result = {
    route: route.path,
    profile: profileName,
    fcpMs: fcp && Math.round(fcp),
    dclMs: nav && Math.round(nav.dcl),
    readyMs,
    totalBytes: sum(() => true),
    jsBytes: sum((r) => r.type === 'Script'),
    cssBytes: sum((r) => r.type === 'Stylesheet'),
    fontBytes: sum((r) => r.type === 'Font'),
    requests: all.length,
    videosOnLoad: new Set(all.filter((r) => r.type === 'Media').map((r) => r.url)).size,
    afterClick,
  };
  await context.close();
  return result;
}

const browser = await chromium.launch({ executablePath: findChrome() });
const results = [];
for (const profileName of Object.keys(PROFILES)) {
  for (const route of ROUTES) {
    // median of 3 runs on the ready metric
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await measure(browser, route, profileName));
    runs.sort((a, b) => a.readyMs - b.readyMs);
    results.push(runs[1]);
  }
}
await browser.close();

for (const r of results) {
  console.log(
    `${r.profile.padEnd(7)} ${r.route.padEnd(11)} FCP ${String(r.fcpMs).padStart(5)} ms  DCL ${String(r.dclMs).padStart(5)} ms  ready ${String(r.readyMs).padStart(5)} ms  ` +
      `total ${kb(r.totalBytes)} (js ${kb(r.jsBytes)}, css ${kb(r.cssBytes)}, fonts ${kb(r.fontBytes)}) reqs ${r.requests} videos ${r.videosOnLoad}` +
      (r.afterClick
        ? `  | after opening a camera: +${kb(r.afterClick.bytes)} in 5 s, videos ${r.afterClick.videos}, detections ${kb(r.afterClick.detectionsBytes)}`
        : ''),
  );
}
if (process.env.JSON) console.log(JSON.stringify(results, null, 2));
