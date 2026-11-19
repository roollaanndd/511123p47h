import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(() => {
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [
        react(),
        VitePWA({
          // Explicit registration + autoUpdate means the generated client checks for
          // a new worker on app startup and activates it without a manual prompt.
          // skipWaiting/clientsClaim below let the new worker take over open tabs.
          // Registration is managed explicitly in index.tsx so there is exactly one
          // update controller and foreground update checks can be attached there.
          injectRegister: null,
          registerType: 'autoUpdate',
          // The repository owns the manifest files so each role entry can
          // point to its own install identity and scope.
          manifest: false,
          includeAssets: [
            'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png', 'pwa-maskable-512.png',
            'manifest.webmanifest', 'manifest-customer.webmanifest', 'manifest-agent.webmanifest',
            'manifest-operator.webmanifest', 'manifest-admin.webmanifest',
          ],
          workbox: {
            maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
            skipWaiting: true,
            clientsClaim: true,
            cleanupOutdatedCaches: true,
            // Precache = app shell only. The old config precached ~4.2 MB / 92 files
            // on first visit — all portal chunks + heavy vendors — competing with the
            // page's own critical requests on mobile connections. Heavy lazy chunks are
            // excluded here and cached on demand by runtimeCaching below (hashed
            // filenames are immutable, so CacheFirst is safe and offline still works
            // for everything the user has actually opened).
            globIgnores: [
              '**/AgentPortal-*.js', '**/AdminPortal-*.js', '**/AdminViews-*.js',
              '**/OperatorPortal-*.js', '**/InsurerPortal-*.js', '**/CustomerPortal-*.js',
              '**/B2BPortal-*.js', '**/CarInsuranceWizard-*.js', '**/ClaimManager-*.js',
              '**/InsurerAdmin-*.js', '**/AgentArt-*.js', '**/AnalyticsDashboard-*.js',
              '**/jspdf*.js', '**/stnkOcr-*.js', '**/geminiService-*.js',
              '**/html2canvas*.js', '**/index.es-*.js', '**/purify.es-*.js',
              '**/quotationSlipAdapter-*.js', '**/quotationService-*.js', '**/aiGateway-*.js',
              '**/logo.jpg', '**/play-store-*.png', '**/screenshot-*.png',
            ],
            runtimeCaching: [
              {
                // Hashed build assets not in the precache — immutable, cache on first use
                urlPattern: /\/assets\/.*\.(?:js|css)$/,
                handler: 'CacheFirst',
                options: {
                  cacheName: 'sp-assets',
                  expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 365 },
                },
              },
              {
                urlPattern: /\.(?:png|jpg|jpeg|svg|webp|ico)$/,
                handler: 'StaleWhileRevalidate',
                options: {
                  cacheName: 'sp-images',
                  expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
                },
              },
              {
                urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/,
                handler: 'StaleWhileRevalidate',
                options: { cacheName: 'google-fonts-css', expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 } },
              },
              {
                urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/,
                handler: 'CacheFirst',
                options: { cacheName: 'google-fonts-woff', expiration: { maxEntries: 24, maxAgeSeconds: 60 * 60 * 24 * 365 } },
              },
            ],
          },
        })
      ],
      build: {
        // FIX v2.9.17 (audit 2026-11-19, kode-eksposur): sourcemap dimatikan
        // EKSPLISIT. Default Vite memang false, tapi default bisa berubah dan
        // satu flag `--sourcemap` di CI sudah cukup untuk menerbitkan kode
        // sumber asli ke internet. `scripts/check-dist-clean.mjs` menjaga hasilnya.
        sourcemap: false,
        // FIX v1.53.0: strip console.log/debug/info in production so 331
        // debug statements don't ship (they can leak PII, tokens, or noise
        // that helps attackers). console.error/warn kept for Sentry.
        minify: 'terser' as const,
        terserOptions: {
          compress: {
            drop_console: ['log', 'debug', 'info'] as (keyof Console)[],
            drop_debugger: true,
            // Dua lintasan memangkas sisa kode setelah lintasan pertama.
            passes: 2,
          },
          // Mangle nama tingkat atas: nama fungsi/konstanta deskriptif
          // (mis. `creditAgentWallet`) tidak lagi menjadi peta gratis bagi
          // pembaca bundel. Ini bukan pengamanan — hanya menaikkan biaya
          // membaca. Logika yang benar-benar sensitif tetap di edge function.
          mangle: { toplevel: true, safari10: true },
        },
        rollupOptions: {
          // APP_SEPARATION_PLAN Fase 2: role entries alongside the universal
          // main entry. They share the same chunk graph (manualChunks below)
          // and stay dormant until a host rewrite serves them.
          input: {
            // The main key must remain `index`: the Android CI "Verify native
            // package" step greps assets/index- in the bundled index.html, and
            // rollup names entry chunks after these input keys.
            index: path.resolve(__dirname, 'index.html'),
            customer: path.resolve(__dirname, 'customer.html'),
            agent: path.resolve(__dirname, 'agent.html'),
            operator: path.resolve(__dirname, 'operator.html'),
            admin: path.resolve(__dirname, 'admin.html'),
          },
          output: {
            manualChunks: {
              'react-vendor': ['react', 'react-dom'],
              'supabase': ['@supabase/supabase-js'],
              // html2canvas removed — was a phantom entry (package isn't installed).
              'lucide': ['lucide-react'],
              // spline removed — @splinetool/* is installed but never imported anywhere.
              // phosphor removed — ModernIcon.tsx was dead code, deleted in v1.42.0.
              // 'pdf' (jspdf) and 'recharts' manual chunks removed: manual chunks
              // absorb shared dependencies, which forced the MAIN entry to statically
              // import both chunks (~240 KB) on every page — including the homepage.
              // jspdf is dynamic-imported and recharts only lives in the lazy
              // AnalyticsDashboard, so natural code-splitting already isolates them.
            },
          },
        },
        chunkSizeWarningLimit: 1000,
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
