/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import {
  exportNameFor, isExportName, issueDownloadTicket, listExports, pruneExports, redeemDownloadTicket,
  resolveExportFile, runExport, sanitizeLabel, startExportJob, getExportJob, connectDatabase,
  type DumpPlan, type DumpProcess, type ExportManifest, type QueryClient,
} from './databaseExport.service';

jest.mock('./containerControl.service', () => ({ getContainerRuntime: () => null, getContainerStatus: jest.fn() }));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-export-'));

function fakeClient(counts: Record<string, number> = { tracks: 3, directories: 1 }) {
  const queries: string[] = [];
  const client = {
    query: async (text: string): Promise<{ rows: any[] }> => {
      queries.push(text.trim());
      if (/pg_export_snapshot/.test(text)) return { rows: [{ snapshot: '00000003-0000001B-1' }] };
      if (/SHOW server_version/.test(text)) return { rows: [{ server_version: '16.13' }] };
      if (/pg_extension/.test(text)) return { rows: [{ extversion: '0.8.2' }] };
      if (/information_schema.columns/.test(text)) return { rows: [{ fingerprint: 'abc123' }] };
      if (/information_schema.tables/.test(text)) return { rows: Object.keys(counts).map(table_name => ({ table_name })) };
      const counted = text.match(/count\(\*\) AS n FROM public\."([^"]+)"/);
      if (counted) return { rows: [{ n: String(counts[counted[1]]) }] };
      if (/FROM directories/.test(text)) return { rows: [{ path: '/music' }] };
      return { rows: [] };
    },
  } as QueryClient;
  return { client, queries };
}

function fakeRunner(output: Buffer[], code = 0, stderr = '') {
  const plans: DumpPlan[] = [];
  const runner = (plan: DumpPlan): DumpProcess => {
    plans.push(plan);
    const proc = new EventEmitter() as EventEmitter & DumpProcess;
    const stdout = new PassThrough();
    const err = new PassThrough();
    Object.assign(proc, { stdout, stderr: err });
    setImmediate(() => {
      for (const chunk of output) stdout.write(chunk);
      stdout.end();
      err.end(stderr);
      setImmediate(() => proc.emit('close', code));
    });
    return proc;
  };
  return { runner, plans };
}

const plan = (snapshot: string) => Promise.resolve({ plan: { method: 'container' as const, command: 'podman', args: ['exec', 'pg', 'pg_dump', `--snapshot=${snapshot}`] } });
const fixedNow = () => new Date('2026-10-13T07:41:03.123Z');

describe('export names and paths', () => {
  it('builds names from time, commit and a sanitised label', () => {
    expect(exportNameFor(fixedNow(), '2fb18b6', sanitizeLabel('Pre Phase 1!'))).toBe('aurora-20261013T074103Z-2fb18b6-pre-phase-1.dump');
    expect(exportNameFor(fixedNow(), 'not a commit', null)).toBe('aurora-20261013T074103Z-unknown.dump');
  });

  it('sanitises labels in linear time, whatever they contain', () => {
    expect(sanitizeLabel('  --Before Upgrade!!--  ')).toBe('before-upgrade');
    expect(sanitizeLabel('-'.repeat(100_000) + 'x')).toBe(null); // capped before it reaches the x
    expect(sanitizeLabel('a' + '-'.repeat(50) + 'b')).toBe('a-b');
    expect(sanitizeLabel('!!!')).toBeNull();
    expect(sanitizeLabel(42)).toBeNull();
  });

  it('accepts only its own names and never resolves outside the export directory', () => {
    const dir = tmp();
    expect(isExportName('aurora-20261013T074103Z-2fb18b6.dump')).toBe(true);
    for (const bad of ['../etc/passwd', 'aurora-20261013T074103Z-2fb18b6.dump/..', 'x.dump', '/abs/aurora-20261013T074103Z-a.dump']) {
      expect(isExportName(bad)).toBe(false);
      expect(() => resolveExportFile(bad, dir)).toThrow();
    }
    expect(resolveExportFile('aurora-20261013T074103Z-2fb18b6.dump', dir)).toBe(path.join(dir, 'aurora-20261013T074103Z-2fb18b6.dump'));
  });
});

describe('runExport', () => {
  it('dumps inside the snapshot it counted rows in, and writes a verifiable manifest', async () => {
    const dir = tmp();
    const { client, queries } = fakeClient();
    const { runner, plans } = fakeRunner([Buffer.from('PGDMP'), Buffer.from('-data')]);
    const manifest = await runExport({ client, runner, plan, dir, now: fixedNow, label: 'test' });

    expect(queries[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(plans[0].args).toContain('--snapshot=00000003-0000001B-1');
    expect(queries.at(-1)).toBe('COMMIT');
    expect(manifest).toMatchObject({
      formatVersion: 1, label: 'test', schemaFingerprint: 'abc123', rowCounts: { tracks: 3, directories: 1 },
      libraryRoots: ['/music'], database: { serverVersion: '16.13', pgvector: '0.8.2' },
      dump: { bytes: 10, method: 'container' },
    });
    const file = resolveExportFile(manifest.name, dir);
    expect(fs.readFileSync(file, 'utf8')).toBe('PGDMP-data');
    expect(manifest.dump.sha256).toBe(require('crypto').createHash('sha256').update('PGDMP-data').digest('hex'));
    expect(listExports(dir).map(m => m.name)).toEqual([manifest.name]);
  });

  it('leaves nothing behind when pg_dump fails, and still ends the transaction', async () => {
    const dir = tmp();
    const { client, queries } = fakeClient();
    const { runner } = fakeRunner([Buffer.from('partial')], 1, 'pg_dump: error: connection refused');
    await expect(runExport({ client, runner, plan, dir, now: fixedNow })).rejects.toThrow('connection refused');
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(queries.at(-1)).toBe('COMMIT');
  });

  it('reports a failed dump only after its file stream has closed, so cleanup cannot race a late write (CI flake)', async () => {
    // CI left a .partial behind: the stream was still opening (fs syscall on the
    // thread pool) when the caller removed the file. The fix makes the failure
    // wait for the stream's close; this pins that order down deterministically.
    const dir = tmp();
    const realCreate = fs.createWriteStream;
    let streamClosed = false;
    const spy = jest.spyOn(fs, 'createWriteStream').mockImplementation(((...args: Parameters<typeof fs.createWriteStream>) => {
      const stream = realCreate(...args);
      stream.on('close', () => { streamClosed = true; });
      return stream;
    }) as typeof fs.createWriteStream);
    try {
      const { runner } = fakeRunner([Buffer.from('partial')], 1, 'pg_dump: error');
      let closedWhenReported: boolean | null = null;
      await runExport({ client: fakeClient().client, runner, plan, dir, now: fixedNow }).catch(() => { closedWhenReported = streamClosed; });
      expect(closedWhenReported).toBe(true);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses an empty dump', async () => {
    const dir = tmp();
    const { runner } = fakeRunner([]);
    await expect(runExport({ client: fakeClient().client, runner, plan, dir, now: fixedNow })).rejects.toThrow('no output');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('says why when no pg_dump is available', async () => {
    const dir = tmp();
    const unavailable = () => Promise.resolve({ plan: null, reason: 'No running database container' });
    await expect(runExport({ client: fakeClient().client, plan: unavailable, dir })).rejects.toThrow('No running database container');
  });
});

describe('retention', () => {
  it('keeps the newest exports and removes dump and manifest together', () => {
    const dir = tmp();
    const names = ['20261010T000000Z', '20261011T000000Z', '20261012T000000Z'].map(stamp => `aurora-${stamp}-abc1234.dump`);
    names.forEach((name, i) => {
      fs.writeFileSync(path.join(dir, name), 'x');
      const manifest = { name, createdAt: `2026-10-1${i}T00:00:00.000Z` } as ExportManifest;
      fs.writeFileSync(path.join(dir, name.replace('.dump', '.json')), JSON.stringify(manifest));
    });
    expect(pruneExports(dir, 2)).toEqual([names[0]]);
    expect(fs.readdirSync(dir).sort()).toEqual([names[1], names[1].replace('.dump', '.json'), names[2], names[2].replace('.dump', '.json')].sort());
  });
});

describe('download tickets', () => {
  it('are single-use and expire after a minute', () => {
    const name = 'aurora-20261013T074103Z-2fb18b6.dump';
    const ticket = issueDownloadTicket(name, 1_000);
    expect(redeemDownloadTicket(ticket, 2_000)).toBe(name);
    expect(redeemDownloadTicket(ticket, 2_000)).toBeNull();
    const late = issueDownloadTicket(name, 1_000);
    expect(redeemDownloadTicket(late, 61_001)).toBeNull();
    expect(redeemDownloadTicket('not-a-ticket')).toBeNull();
    expect(() => issueDownloadTicket('../secret')).toThrow();
  });
});

describe('export job', () => {
  it('runs one export at a time and reports the outcome', async () => {
    let finish!: (manifest: ExportManifest) => void;
    const first = startExportJob(() => new Promise(resolve => { finish = resolve; }));
    const second = startExportJob(() => Promise.reject(new Error('should not run')));
    expect(second).toBe(first);
    finish({ name: 'aurora-20261013T074103Z-2fb18b6.dump' } as ExportManifest);
    await new Promise(resolve => setImmediate(resolve));
    expect(getExportJob()).toMatchObject({ state: 'done', name: 'aurora-20261013T074103Z-2fb18b6.dump' });
  });
});

describe('connectDatabase', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });
  const factory = (failHosts: string[]) => {
    const hosts: string[] = [];
    const make = (config: { host?: string }) => ({
      connect: async () => {
        hosts.push(String(config.host));
        if (failHosts.includes(String(config.host))) throw new Error('Connection terminated unexpectedly');
      },
      end: async () => undefined,
      query: async () => ({ rows: [] }),
    });
    return { make, hosts };
  };

  it('retries localhost on 127.0.0.1 when the IPv6 connection is dropped (rootless Podman, prod 2026-10-13)', async () => {
    process.env.DB_HOST = 'localhost';
    const { make, hosts } = factory(['localhost']);
    const warn = jest.fn();
    await connectDatabase('musicdb', make, warn);
    expect(hosts).toEqual(['localhost', '127.0.0.1']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Set DB_HOST=127.0.0.1'));
  });

  it('does not second-guess an explicit host', async () => {
    process.env.DB_HOST = 'db.internal';
    const { make, hosts } = factory(['db.internal']);
    await expect(connectDatabase('musicdb', make, jest.fn())).rejects.toThrow('Connection terminated unexpectedly');
    expect(hosts).toEqual(['db.internal']);
  });
});
