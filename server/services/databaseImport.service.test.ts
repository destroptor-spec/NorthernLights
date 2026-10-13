/**
 * @jest-environment node
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { importDatabase, ImportRefusedError, missingLibraryRoots, readManifest, type ClosableClient, type RestorePlan, type RestoreProcess } from './databaseImport.service';
import type { ExportManifest } from './databaseExport.service';

jest.mock('./containerControl.service', () => ({ getContainerRuntime: () => null, getContainerStatus: jest.fn() }));

const NAME = 'aurora-20261013T075850Z-11d14c3.dump';

function writeExport(overrides: Partial<ExportManifest> = {}, content = 'PGDMP-data') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-import-'));
  const dumpPath = path.join(dir, NAME);
  fs.writeFileSync(dumpPath, content);
  const manifest: ExportManifest = {
    formatVersion: 1, name: NAME, label: null, createdAt: '2026-10-13T07:58:50.000Z',
    app: { version: '1.0.0-rc.6', commit: '11d14c3' },
    database: { name: 'musicdb', serverVersion: '16.13 (Debian)', pgvector: '0.8.2' },
    schemaFingerprint: 'abc', rowCounts: { tracks: 2, users: 1 }, libraryRoots: ['/music'],
    dump: { bytes: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex'), method: 'container' },
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, NAME.replace('.dump', '.json')), JSON.stringify(manifest));
  return dumpPath;
}

/** A fake Postgres: the admin connection, plus the restored database's tables and counts. */
function fakePostgres({ targetExists = true, connected = 0, serverVersionNum = '160013', restored = { tracks: 2, users: 1 } as Record<string, number> } = {}) {
  const adminSql: string[] = [];
  const copySql: string[] = [];
  const admin = {
    query: async (text: string) => {
      adminSql.push(text.trim());
      if (/server_version_num/.test(text)) return { rows: [{ server_version_num: serverVersionNum }] };
      if (/pg_available_extensions/.test(text)) return { rows: [{ '?column?': 1 }] };
      if (/FROM pg_database/.test(text)) return { rows: targetExists ? [{}] : [] };
      if (/pg_stat_activity/.test(text)) return { rows: [{ n: String(connected) }] };
      return { rows: [] };
    },
  } as unknown as ClosableClient;
  const copy = {
    query: async (text: string) => {
      copySql.push(text.trim());
      if (/information_schema.tables/.test(text)) return { rows: Object.keys(restored).map(table_name => ({ table_name })) };
      const counted = text.match(/count\(\*\) AS n FROM public\."([^"]+)"/);
      if (counted) return { rows: [{ n: String(restored[counted[1]]) }] };
      if (/WITH gone AS/.test(text)) return { rows: [{ n: '1' }] };
      return { rows: [] };
    },
    end: jest.fn(async () => undefined),
  } as unknown as ClosableClient;
  return { admin, copy, adminSql, copySql, connectTo: jest.fn(async () => copy) };
}

function fakeRestore(code = 0, stderr = 'pg_restore: processing data for table "public.tracks"\n') {
  const plans: RestorePlan[] = [];
  const runner = (plan: RestorePlan): RestoreProcess => {
    plans.push(plan);
    const proc = new EventEmitter() as EventEmitter & RestoreProcess;
    const err = new PassThrough();
    Object.assign(proc, { stdin: new PassThrough(), stderr: err });
    setImmediate(() => { err.end(stderr); setImmediate(() => proc.emit('close', code)); });
    return proc;
  };
  return { runner, plans };
}

const plan = (database: string, dumpPath: string) => Promise.resolve({ plan: { method: 'container' as const, command: 'podman', args: ['exec', '-i', 'pg', 'pg_restore', '-d', database], stdinFile: dumpPath } });
const now = () => new Date('2026-10-13T08:04:51Z');
const base = (pg: ReturnType<typeof fakePostgres>, dumpPath: string, extra = {}) => ({
  dumpPath, admin: pg.admin, connectTo: pg.connectTo, rotate: false, confirmSwitch: async () => true,
  plan, runner: fakeRestore().runner, rootExists: () => true, now, ...extra,
});

describe('importDatabase', () => {
  it('restores into a new database, verifies it, then switches and keeps the previous one', async () => {
    const pg = fakePostgres();
    const { runner, plans } = fakeRestore();
    const result = await importDatabase({ ...base(pg, writeExport()), runner });
    expect(plans[0].args).toContain('musicdb_import_20261013080451');
    expect(pg.adminSql).toContain('CREATE DATABASE "musicdb_import_20261013080451"');
    expect(pg.adminSql).toContain('ALTER DATABASE "musicdb" RENAME TO "musicdb_prev_20261013080451"');
    expect(pg.adminSql).toContain('ALTER DATABASE "musicdb_import_20261013080451" RENAME TO "musicdb"');
    expect(result).toMatchObject({ switched: true, previous: 'musicdb_prev_20261013080451', rotated: [] });
  });

  it('on a fresh host with no database, only renames the import into place', async () => {
    const pg = fakePostgres({ targetExists: false });
    const result = await importDatabase(base(pg, writeExport()));
    expect(pg.adminSql.some(sql => /RENAME TO "musicdb_prev/.test(sql))).toBe(false);
    expect(result).toMatchObject({ switched: true, previous: null });
  });

  it('leaves the verified copy beside the live database when the switch is declined', async () => {
    const pg = fakePostgres();
    const result = await importDatabase(base(pg, writeExport(), { confirmSwitch: async () => false }));
    expect(pg.adminSql.some(sql => /RENAME/.test(sql))).toBe(false);
    expect(pg.adminSql.some(sql => /DROP DATABASE/.test(sql))).toBe(false);
    expect(result).toMatchObject({ switched: false, imported: 'musicdb_import_20261013080451' });
  });

  it('gives a copy its own identity only when asked', async () => {
    const pg = fakePostgres();
    const result = await importDatabase(base(pg, writeExport(), { rotate: true }));
    expect(pg.copySql.some(sql => /'jwtSecret'/.test(sql))).toBe(true);
    expect(pg.copySql.some(sql => /DELETE FROM aurora_app_keys/.test(sql))).toBe(true);
    expect(pg.copySql.some(sql => /turnstileEnabled/.test(sql))).toBe(true);
    expect(result.rotated.length).toBeGreaterThan(3);
  });

  it.each([
    ['a missing library folder', { rootExists: () => false }, {}, /library folders do not exist/],
    ['Aurora still connected', {}, { connected: 1 }, /Stop Aurora first/],
    ['an older Postgres', {}, { serverVersionNum: '150004' }, /from Postgres 16; this server runs 15/],
  ])('refuses %s before creating anything', async (_label, extra, pgOptions, message) => {
    const pg = fakePostgres(pgOptions);
    await expect(importDatabase(base(pg, writeExport(), extra))).rejects.toThrow(message);
    expect(pg.adminSql.some(sql => /CREATE DATABASE/.test(sql))).toBe(false);
  });

  it('refuses a file that does not match its manifest', async () => {
    const dumpPath = writeExport({}, 'PGDMP-data');
    fs.appendFileSync(dumpPath, 'tampered');
    const pg = fakePostgres();
    await expect(importDatabase(base(pg, dumpPath))).rejects.toThrow(ImportRefusedError);
    expect(pg.adminSql).toEqual([]);
  });

  it.each([
    ['pg_restore fails', { runner: fakeRestore(1, 'pg_restore: error: could not execute query').runner }, {}, /could not execute query/],
    ['a row count differs', {}, { restored: { tracks: 1, users: 1 } }, /tracks: 1 rows, expected 2/],
    ['a table is missing', {}, { restored: { tracks: 2 } }, /users: missing/],
  ])('drops the new database and switches nothing when %s', async (_label, extra, pgOptions, message) => {
    const pg = fakePostgres(pgOptions);
    await expect(importDatabase(base(pg, writeExport(), extra))).rejects.toThrow(message);
    expect(pg.adminSql).toContain('DROP DATABASE IF EXISTS "musicdb_import_20261013080451"');
    expect(pg.adminSql.some(sql => /RENAME/.test(sql))).toBe(false);
  });
});

describe('helpers', () => {
  it('reads only a matching manifest of a supported format', () => {
    expect(readManifest(writeExport()).name).toBe(NAME);
    expect(() => readManifest(writeExport({ formatVersion: 2 }))).toThrow('Unsupported export format 2');
    expect(() => readManifest(writeExport({ name: 'aurora-20261013T000000Z-other.dump' }))).toThrow('describes');
    expect(() => readManifest('/nowhere/aurora-20261013T075850Z-11d14c3.dump')).toThrow('manifest is missing');
  });

  it('reports library folders that are not on this host', () => {
    expect(missingLibraryRoots(['/a', '/b'], dir => dir === '/a')).toEqual(['/b']);
  });
});
