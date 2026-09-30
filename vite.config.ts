import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin, type Rolldown } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apiDevBridge } from './api/_lib/viteDevBridge.ts'

/**
 * Pages are lazy chunks, so without help the browser only discovers the
 * current page's JS (and Leaflet) after the entry chunk has downloaded and
 * run — an extra network round-trip on every cold load. This injects a tiny
 * inline script that, based on location.pathname, adds <link rel=modulepreload>
 * (and the page CSS) for just that route's chunks, in parallel with the entry.
 * Keep ROUTE_PAGES in sync with src/app/routes.ts.
 */
const ROUTE_PAGES: Record<string, string> = {
  '/': 'src/features/live-map/pages/LiveMapPage.tsx',
  '/cameras': 'src/features/cameras/pages/CamerasPage.tsx',
  '/vehicles': 'src/features/vehicles/pages/VehiclesPage.tsx',
  '/alerts': 'src/features/alerts/pages/AlertsPage.tsx',
  '/analytics': 'src/features/analytics/pages/AnalyticsPage.tsx',
  '/model': 'src/features/model-performance/pages/ModelPerformancePage.tsx',
  '/detections': 'src/features/detections/pages/DetectionsPage.tsx',
  '/admin': 'src/features/admin/pages/AdminPage.tsx',
  '/login': 'src/features/auth/LoginPage.tsx',
}

function routePreloadPlugin(): Plugin {
  return {
    name: 'nero-route-preload',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const bundle = ctx.bundle
        if (!bundle) return html
        const chunks = Object.values(bundle).filter((c): c is Rolldown.OutputChunk => c.type === 'chunk')
        const byFile = new Map(chunks.map((c) => [c.fileName, c]))
        const entry = chunks.find((c) => c.isEntry)
        const already = new Set<string>()
        const collect = (c: Rolldown.OutputChunk, out: Set<string>) => {
          if (out.has(c.fileName)) return
          out.add(c.fileName)
          for (const i of c.imports) {
            const dep = byFile.get(i)
            if (dep) collect(dep, out)
          }
        }
        if (entry) collect(entry, already)

        const map: Record<string, string[]> = {}
        for (const [route, page] of Object.entries(ROUTE_PAGES)) {
          const chunk = chunks.find((c) => c.facadeModuleId?.replaceAll('\\', '/').endsWith(page))
          if (!chunk) continue
          const files = new Set<string>()
          collect(chunk, files)
          const list: string[] = []
          for (const f of files) {
            if (already.has(f)) continue
            list.push(f)
            const css = (byFile.get(f) as { viteMetadata?: { importedCss?: Set<string> } } | undefined)?.viteMetadata?.importedCss
            css?.forEach((c) => list.push(c))
          }
          map[route] = list
        }
        const script =
          `(function(m){var p=location.pathname.replace(/\\/+$/,'')||'/',f=m[p];if(!f)return;` +
          `f.forEach(function(h){var l=document.createElement('link');` +
          `if(/\\.css$/.test(h)){l.rel='stylesheet'}else{l.rel='modulepreload';l.crossOrigin=''}` +
          `l.href='/'+h;document.head.appendChild(l)})})(${JSON.stringify(map)})`
        return [{ tag: 'script', children: script, injectTo: 'head' }]
      },
    },
  }
}


/**
 * public/videos-local/ holds ~100 MB of symlinked dev clips
 * (pipeline/tools/link_local_videos.py, gitignored). Vite would copy it into
 * dist/ on every build, so this plugin:
 *   - build:   disables Vite's public-dir copy and copies public/ itself,
 *              skipping videos-local/ (production streams from Supabase Storage);
 *   - preview: serves /videos-local/* straight from public/ (with HTTP Range
 *              support so <video> can seek), so `vite preview` still plays
 *              local clips. `vite dev` serves public/ as usual.
 */
const LOCAL_VIDEOS_DIR = 'videos-local'
const VIDEO_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.json': 'application/json', '.webm': 'video/webm' }

function serveLocalVideos(root: string) {
  const base = path.resolve(root, 'public', LOCAL_VIDEOS_DIR)
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0])
    if (!url.startsWith(`/${LOCAL_VIDEOS_DIR}/`)) return next()
    const file = path.resolve(base, url.slice(LOCAL_VIDEOS_DIR.length + 2))
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) return next()
    const { size } = fs.statSync(file)
    const type = VIDEO_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', type)
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (start >= size || start > end) {
        res.statusCode = 416
        res.setHeader('Content-Range', `bytes */${size}`)
        return res.end()
      }
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
      res.setHeader('Content-Length', String(end - start + 1))
      fs.createReadStream(file, { start, end }).pipe(res)
      return
    }
    res.setHeader('Content-Length', String(size))
    fs.createReadStream(file).pipe(res)
  }
}

function localVideosPlugin(): Plugin {
  let root = process.cwd()
  let outDir = 'dist'
  let publicDir = ''
  return {
    name: 'nero-local-videos',
    config(_cfg, { command }) {
      if (command === 'build') return { build: { copyPublicDir: false } }
    },
    configResolved(cfg) {
      root = cfg.root
      outDir = path.resolve(cfg.root, cfg.build.outDir)
      publicDir = cfg.publicDir
    },
    writeBundle() {
      if (!publicDir || !fs.existsSync(publicDir)) return
      const skip = path.join(publicDir, LOCAL_VIDEOS_DIR)
      fs.cpSync(publicDir, outDir, {
        recursive: true,
        dereference: true,
        filter: (src) => src !== skip && !src.startsWith(skip + path.sep),
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveLocalVideos(root))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // apiDevBridge: dev-only /api/detect + /api/health (reads DETECTION_API_* server-side; see the file)
  plugins: [react(), tailwindcss(), routePreloadPlugin(), localVideosPlugin(), apiDevBridge()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    // Page chunks are lazy (src/app/routes.ts). Vendor code is split into
    // stable, separately cacheable chunks so an app-code deploy doesn't
    // invalidate React/Supabase/Leaflet in users' caches, and Leaflet only
    // loads with the map pages.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'vendor-router', test: /node_modules[\\/](react-router|react-router-dom)[\\/]/, priority: 25 },
            { name: 'vendor-supabase', test: /node_modules[\\/]@supabase[\\/]/, priority: 20 },
            { name: 'vendor-leaflet', test: /node_modules[\\/](leaflet|react-leaflet|@react-leaflet)[\\/]/, priority: 20 },
          ],
        },
      },
    },
  },
})
