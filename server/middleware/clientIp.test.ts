import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import { getTrustedClientIp, resolveClientIp } from './clientIp';

describe('resolveClientIp', () => {
  const SOCKET = '10.10.0.5';
  const spoofedHeaders = {
    'x-forwarded-for': '6.6.6.6, 203.0.113.7',
    'cf-connecting-ip': '6.6.6.7',
  };

  it('direct mode uses the socket address and ignores all spoofable headers', () => {
    expect(resolveClientIp('direct', spoofedHeaders, SOCKET)).toBe(SOCKET);
    expect(resolveClientIp('direct', {}, SOCKET)).toBe(SOCKET);
  });

  it('proxy mode takes the right-most X-Forwarded-For entry (appended by the trusted proxy)', () => {
    expect(resolveClientIp('proxy', { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }, SOCKET)).toBe('203.0.113.7');
    expect(resolveClientIp('proxy', { 'x-forwarded-for': '198.51.100.4' }, SOCKET)).toBe('198.51.100.4');
  });

  it('proxy mode falls back to the socket without an XFF header', () => {
    expect(resolveClientIp('proxy', {}, SOCKET)).toBe(SOCKET);
    expect(resolveClientIp('proxy', { 'x-forwarded-for': '  ' }, SOCKET)).toBe(SOCKET);
  });

  it('cloudflare mode prefers CF-Connecting-IP', () => {
    expect(resolveClientIp('cloudflare', {
      'cf-connecting-ip': '198.51.100.9',
      'x-forwarded-for': '6.6.6.6, 203.0.113.7',
    }, SOCKET)).toBe('198.51.100.9');
  });

  it('cloudflare mode falls back to right-most XFF, then socket', () => {
    expect(resolveClientIp('cloudflare', { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }, SOCKET)).toBe('203.0.113.7');
    expect(resolveClientIp('cloudflare', {}, SOCKET)).toBe(SOCKET);
  });

  it('handles array-valued headers and missing socket address', () => {
    expect(resolveClientIp('cloudflare', { 'cf-connecting-ip': ['198.51.100.9'] }, SOCKET)).toBe('198.51.100.9');
    expect(resolveClientIp('direct', {}, undefined)).toBe('unknown');
  });
});

// Prod 2026-11-02: TRUSTED_PROXY_MODE=cloudflare sat in .env, yet every
// auth.log line showed the proxy's socket address. The mode was read once when
// this module loaded, which was before server/index.ts loaded .env.
describe('getTrustedClientIp', () => {
  const original = process.env.TRUSTED_PROXY_MODE;
  afterEach(() => {
    if (original === undefined) delete process.env.TRUSTED_PROXY_MODE;
    else process.env.TRUSTED_PROXY_MODE = original;
  });

  const req = {
    headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' },
    socket: { remoteAddress: '::ffff:10.10.0.8' },
  } as unknown as Request;

  it('follows a TRUSTED_PROXY_MODE set after the module was loaded', () => {
    delete process.env.TRUSTED_PROXY_MODE;
    expect(getTrustedClientIp(req)).toBe('::ffff:10.10.0.8');
    process.env.TRUSTED_PROXY_MODE = 'cloudflare';
    expect(getTrustedClientIp(req)).toBe('203.0.113.7');
  });

  it('server/index.ts loads .env in its first import, before any module reads it', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    const firstImport = source.match(/^import\s[^;]*;/m)?.[0];
    expect(firstImport).toBe("import 'dotenv/config';");
  });
});
