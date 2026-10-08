import express from 'express';
import path from 'path';

export function createFrontendStaticRouter(distPath: string) {
  const router = express.Router();
  const receiverPath = path.join(distPath, 'receiver.html');
  router.use(express.static(distPath, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath === receiverPath) res.removeHeader('Content-Security-Policy');
      // HTML and worker scripts must be revalidated on deployment. Hashed
      // assets remain eligible for normal browser and service-worker caching.
      if (filePath.endsWith('.html') || filePath === path.join(distPath, 'sw.js')
        || /^workbox-.*\.js$/.test(path.basename(filePath))) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  // Never let the SPA fallback turn a missing chunk into successful HTML.
  // Workbox accepts 200 responses during installation, so doing that would
  // install a broken app shell instead of rejecting an incomplete deployment.
  router.use('/assets', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).type('text').send('Asset not found');
  });
  router.get(/^\/(?:sw\.js|workbox-[^/]+\.js)$/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).type('text').send('Service worker script not found');
  });
  return router;
}
