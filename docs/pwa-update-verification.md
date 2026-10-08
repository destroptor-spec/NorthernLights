# PWA update reliability

The app owns service-worker registration, update discovery, and navigation in
`src/main.tsx` and `src/utils/pwaUpdate.ts`. Vite PWA still generates the manifest
and Workbox worker, including the existing media caches. Automatic registration
injection and automatic skip-waiting are disabled.

## Findings addressed (2026-10-08)

- The old update action always armed a ten-second reload timer. The plugin's
  controlling callback checked whether a controller existed at registration;
  in a session that began with the first installation, it skipped its normal
  reload. A production Firefox fixture reproduced the full ten-second delay.
- The plugin could attach multiple reload callbacks through its installed and
  waiting notifications. Navigation now has one owner and a once-only guard.
- A failed installation classified as external caused Workbox-window to stop
  watching subsequent `updatefound` events. A browser fixture reproduced a
  repaired deployment installing without an update prompt. Native lifecycle
  listeners now observe every attempt, regardless of which tab initiated it.
- The production SPA fallback returned index HTML with status 200 for missing
  hashed assets. Workbox can accept those responses during precaching, producing
  an installed build whose scripts cannot execute. Missing assets and worker
  scripts now return 404 with `no-store`; HTML and worker entrypoints revalidate.

The blank page reported on users' devices was not captured directly. These are
verified update defects and a concrete broken-shell path, not a claim that every
possible startup failure has been eliminated.

## Resulting behavior

The prompt appears only for a waiting update or a controller replaced by another
tab. Reload snapshots playback continuity, disables repeat clicks, and shows
Updating. The app waits until the selected worker is both activated and in control
before navigating. After fifteen seconds without confirmation, it stays open,
shows a retryable error, and removes activation listeners. Late activation cannot
force a reload after the timeout. Another tab can apply the same update without
forcing this tab to reload.

Visible, online sessions check every minute. Visibility and reconnect events
share the same throttle; installing/waiting workers are left undisturbed.

## Automated checks

```sh
npx tsc --noEmit
npm test -- --runInBand server/middleware/frontendStatic.test.ts src/utils/__tests__/pwaUpdate.test.ts src/utils/__tests__/pwaRuntimeCaching.test.ts
npx vite build
```

The 27 targeted tests cover both activation/control event orders, duplicate
clicks, timeout and retry, replaced workers, transport failure, registration not
ready, other-tab activation, first installation, failed-install recovery,
background checks, existing adaptive audio caching, missing files, cache headers,
SPA navigation, and the existing receiver CSP exemption.

## Browser evidence

An isolated localhost Express server served actual production builds through the
production static router. API responses used an empty-library fixture; no live
music database, account, or playback session was modified. Headless Firefox
verified:

1. First installation and activation, followed by a different production build.
2. A deliberately missing entry bundle rejects installation and keeps the old
   app usable, without a false update prompt.
3. Repairing that deployment produces a new prompt without reopening the tab.
4. Applying the update navigates exactly once, renders the app, and produces no
   uncaught page errors.
5. A second tab remains open and applies the already-activated update on request.
6. Offline reload after the update serves the new build and renders the app.

Local run artifacts: `/tmp/aurora-pwa-update-20261008/` (browser harness, build
logs, browser-results.log, and screenshots). These scratch files are not required
by the app and are not repository dependencies.

Still to verify on deployment: installed mobile/desktop app behavior in Chrome
and Firefox, actual playback continuity across reload, and the real reverse
proxy's response/cache headers. Restart the server when deploying frontend and
backend changes together; the server retains its startup HTML/CSP snapshot.
Existing clients execute the old updater until they have loaded this fix once.

Lifecycle references:
[Service worker updatefound](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/updatefound_event),
[registration and updateViaCache](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register).
