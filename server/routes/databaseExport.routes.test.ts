/** @jest-environment node */
jest.mock('music-metadata', () => ({}), { virtual: true });
jest.mock('../database', () => ({ initDB: jest.fn() }));
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import type { Request, Response } from 'express';
import adminRouter from './admin.routes';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { issueDownloadTicket } from '../services/databaseExport.service';

/** Database export routes: everything is admin-only except the ticketed download. */
const layerFor = (method: string, routePath: string) =>
  (adminRouter as any).stack.find((l: any) => l.route?.path === routePath && l.route.stack.some((h: any) => h.method === method));

describe('database export routes', () => {
  it.each([
    ['get', '/db/exports'],
    ['post', '/db/exports'],
    ['post', '/db/exports/:name/download-ticket'],
    ['delete', '/db/exports/:name'],
  ])('%s %s requires an admin', (method, routePath) => {
    const handlers = layerFor(method, routePath).route.stack.map((h: any) => h.handle);
    expect(handlers).toContain(requireAdmin);
  });

  it('the global auth middleware lets only the ticketed download through without a login', async () => {
    // Found by running the real server: the unit-tested route was unreachable behind requireAuth.
    const attempt = async (path: string) => {
      const next = jest.fn();
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
      await requireAuth({ path, headers: {}, query: {} } as unknown as Request, res as unknown as Response, next);
      return next.mock.calls.length > 0;
    };
    expect(await attempt('/api/admin/db/exports/download')).toBe(true);
    expect(await attempt('/api/admin/db/exports')).toBe(false);
    expect(await attempt('/api/admin/db/exports/aurora-20261013T074103Z-2fb18b6.dump/download-ticket')).toBe(false);
  });

  describe('GET /db/exports/download', () => {
    const name = 'aurora-20261013T074103Z-2fb18b6.dump';
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-export-route-'));
      process.env.DB_EXPORT_DIR = dir;
      fs.writeFileSync(path.join(dir, name), 'PGDMP-data');
    });
    afterEach(() => { delete process.env.DB_EXPORT_DIR; });

    const download = (query: Record<string, unknown>) => {
      const handlers = layerFor('get', '/db/exports/download').route.stack.map((h: any) => h.handle);
      expect(handlers).not.toContain(requireAdmin); // a browser download cannot send the Authorization header
      const res = Object.assign(new PassThrough(), {
        status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), setHeader: jest.fn(),
      });
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      const done = new Promise<string>(resolve => res.on('end', () => resolve(Buffer.concat(chunks).toString())));
      handlers[handlers.length - 1]({ query } as unknown as Request, res as unknown as Response, jest.fn());
      return { res, done };
    };

    it('refuses a missing, forged or reused ticket', async () => {
      for (const ticket of [undefined, 'abc', 'f'.repeat(64)]) {
        const { res } = download({ ticket });
        expect(res.status).toHaveBeenCalledWith(403);
      }
      const ticket = issueDownloadTicket(name);
      await download({ ticket }).done;
      expect(download({ ticket }).res.status).toHaveBeenCalledWith(403);
    });

    it('streams the export as an uncached attachment for a valid ticket', async () => {
      const { res, done } = download({ ticket: issueDownloadTicket(name) });
      expect(await done).toBe('PGDMP-data');
      expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', `attachment; filename="${name}"`);
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
      expect(res.setHeader).toHaveBeenCalledWith('Content-Length', '10');
    });
  });
});
