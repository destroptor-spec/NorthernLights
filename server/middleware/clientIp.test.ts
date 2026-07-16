import { resolveClientIp } from './clientIp';

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
