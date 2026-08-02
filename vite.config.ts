import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import {
  adaptiveAudioChunkFallbackPlugin,
  adaptivePlaylistFallbackPlugin,
  isAdaptiveHlsPlaylistRequest,
  isAdaptiveHlsSegmentRequest,
} from './src/utils/pwaRuntimeCaching';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: 'auto',
      manifest: {
        name: 'NorthernLights',
        short_name: 'NorthernLights',
        description: 'A modern web-based music player with local file playback, metadata editing, and playlist management.',
        // Stable app identity, independent of start_url. Set to match the implicit
        // id (the resolved start_url) so already-installed PWAs aren't treated as a
        // new app on update. Changing start_url later won't reshuffle the identity.
        id: '/?source=pwa',
        start_url: '/?source=pwa',
        scope: '/',
        lang: 'en',
        dir: 'ltr',
        theme_color: '#050311',
        background_color: '#050311',
        display: 'standalone',
        display_override: ['standalone', 'browser'],
        orientation: 'portrait-primary',
        categories: ['music', 'entertainment'],
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icon-384.png',
            sizes: '384x384',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ],
        screenshots: [
          {
            src: '/splash/pwa-screenshot-wide.png',
            sizes: '2880x1620',
            type: 'image/png',
            form_factor: 'wide',
            label: 'Aurora NorthernLights splash screen'
          },
          {
            src: '/splash/pwa-screenshot-narrow.png',
            sizes: '1290x2796',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'Aurora NorthernLights mobile splash screen'
          }
        ],
        shortcuts: [
          {
            name: 'Open Hub',
            short_name: 'Hub',
            description: 'Browse your music library',
            url: '/library?source=shortcut',
            icons: [{ src: '/icon-192.png', sizes: '192x192' }]
          },
          {
            name: 'Playlists',
            short_name: 'Playlists',
            description: 'View your playlists',
            url: '/playlists?source=shortcut',
            icons: [{ src: '/icon-192.png', sizes: '192x192' }]
          }
        ]
      },
      workbox: {
        clientsClaim: true,
        // Drop precaches from previous builds when a new SW activates.
        cleanupOutdatedCaches: true,
        // Serve the cached app shell for offline/refresh navigations so client
        // routes resolve without a network round-trip. API and auth requests are
        // excluded so they aren't answered with HTML.
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/rest\//],
        runtimeCaching: [
          {
            // Auto can cache different aligned renditions for adjacent segment
            // numbers. On an exact offline miss, reuse the cached bytes for the
            // same track/segment path instead of trying an uncached rendition.
            urlPattern: isAdaptiveHlsSegmentRequest,
            handler: 'CacheFirst',
            options: {
              cacheName: 'nl-audio-chunks-v1',
              expiration: { maxEntries: 2000, maxAgeSeconds: 604800 }, // 7 days
              cacheableResponse: { statuses: [0, 200] },
              plugins: [adaptiveAudioChunkFallbackPlugin]
            }
          },
          {
            // HLS transport stream segments — immutable chunks used by browser playback.
            urlPattern: /\/api\/stream\/.*\.ts(\?.*)?$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'nl-audio-chunks-v1',
              expiration: { maxEntries: 2000, maxAgeSeconds: 604800 }, // 7 days
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            // An offline ABR replay may choose a rendition whose media playlist
            // was never fetched. Every adaptive rendition is segment-aligned, so
            // a cached playlist with the same pathname is a valid recovery source.
            urlPattern: isAdaptiveHlsPlaylistRequest,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'nl-audio-playlists-v1',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 200, maxAgeSeconds: 86400 },
              cacheableResponse: { statuses: [0, 200] },
              plugins: [adaptivePlaylistFallbackPlugin]
            }
          },
          {
            // HLS playlists stay fresh when online, with cache fallback for previously played tracks.
            urlPattern: /\/api\/stream\/.*\.m3u8(\?.*)?$/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'nl-audio-playlists-v1',
              // Fall back to the cached playlist quickly when the network is slow
              // or offline, instead of hanging on a dead request.
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 200, maxAgeSeconds: 86400 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            // Album art cache (kept from legacy media-cache). maxEntries must
            // comfortably exceed a real library's distinct cover count — at 500
            // a large library LRU-evicts covers mid-browse and re-downloads them
            // on the next visit, defeating the cache.
            urlPattern: /\/api\/art(\?.*)?$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'media-cache',
              expiration: { maxEntries: 4000, maxAgeSeconds: 2592000 }, // 30 days
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            // Public deterministic third-party imagery proxied through Aurora.
            // Must stay above the generic /api/ NetworkOnly rule.
            urlPattern: /\/api\/providers\/external\/proxy-image(\?.*)?$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'external-image-proxy-cache',
              expiration: { maxEntries: 200, maxAgeSeconds: 604800 }, // 7 days
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            // Keep authenticated/user-specific API data out of Cache Storage.
            urlPattern: /\/api\//,
            handler: 'NetworkOnly'
          },
          {
            urlPattern: /\.(?:png|jpg|jpeg|gif|webp|avif)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'image-cache',
              expiration: { maxEntries: 300, maxAgeSeconds: 2592000 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-stylesheets'
            }
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 31536000 },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      }
    })
  ],
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // lucide-react must be tested BEFORE the generic `react` check —
            // 'lucide-react'.includes('react') is true, so the react branch would
            // otherwise swallow it into vendor-react and this chunk would never emit.
            if (id.includes('lucide-react')) {
              return 'vendor-icons';
            }
            if (id.includes('react') || id.includes('react-dom') || id.includes('react-router')) {
              return 'vendor-react';
            }
            if (id.includes('hls.js')) {
              return 'vendor-hls';
            }
          }
        }
      }
    }
  },
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  },
});
