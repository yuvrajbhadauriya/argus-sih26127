import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin, type Rolldown } from 'vite'
import { fileURLToPath, URL } from 'node:url'

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
  '/detections': 'src/features/detections/pages/DetectionsPage.tsx',
  '/admin': 'src/features/admin/pages/AdminPage.tsx',
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), routePreloadPlugin()],
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
