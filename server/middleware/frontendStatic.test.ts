/** @jest-environment node */
import express from 'express';
import { IncomingMessage, ServerResponse } from 'http';
import type { Socket } from 'net';
import { Duplex } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createFrontendStaticRouter } from './frontendStatic';

// Exercise Express and send's actual file streaming without opening a port.
function request(app: express.Express, url: string) {
  return new Promise<{ status: number; headers: ReturnType<ServerResponse['getHeaders']>; wire: string }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    });
    const req = new IncomingMessage(socket as Socket);
    req.method = 'GET';
    req.url = url;
    const res = new ServerResponse(req);
    res.assignSocket(socket as Socket);
    res.on('error', reject);
    res.on('finish', () => {
      resolve({ status: res.statusCode, headers: res.getHeaders(), wire: Buffer.concat(chunks).toString() });
      socket.destroy();
    });
    app(req, res);
  });
}

describe('production PWA assets', () => {
  let directory: string;
  let app: express.Express;
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-pwa-static-'));
    fs.mkdirSync(path.join(directory, 'assets'));
    for (const [name, content] of Object.entries({
      'index.html': '<html>APP SHELL</html>',
      'receiver.html': '<html>RECEIVER</html>',
      'sw.js': '/* worker */',
      'workbox-build.js': '/* runtime */',
      'assets/index-hash.js': 'console.log("valid chunk");',
    })) fs.writeFileSync(path.join(directory, name), content);
    app = express();
    app.use((_req, res, next) => { res.setHeader('Content-Security-Policy', "script-src 'self'"); next(); });
    app.use(createFrontendStaticRouter(directory));
    app.get('/{*splat}', (_req, res) => { res.type('html').send('APP SHELL'); });
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  it.each(['/assets/missing.js', '/assets/missing.css', '/workbox-missing.js'])('returns 404 instead of cacheable HTML for %s', async (url) => {
    const response = await request(app, url);
    expect(response.status).toBe(404);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.wire).not.toContain('APP SHELL');
  });

  it.each(['/index.html', '/sw.js', '/workbox-build.js'])('revalidates deployment entrypoint %s', async (url) => {
    const response = await request(app, url);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it('serves existing hashed chunks and preserves SPA navigation', async () => {
    const chunk = await request(app, '/assets/index-hash.js');
    expect(chunk.status).toBe(200);
    expect(chunk.headers['content-type']).toContain('javascript');
    expect(chunk.wire).toContain('valid chunk');
    const navigation = await request(app, '/library');
    expect(navigation.status).toBe(200);
    expect(navigation.wire).toContain('APP SHELL');
  });

  it('preserves the receiver CSP exemption without removing the app policy', async () => {
    expect((await request(app, '/receiver.html')).headers['content-security-policy']).toBeUndefined();
    expect((await request(app, '/index.html')).headers['content-security-policy']).toBe("script-src 'self'");
  });
});
