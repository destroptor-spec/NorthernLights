/**
 * @jest-environment node
 */
import { databaseHost } from './dbHost';

describe('databaseHost', () => {
  it('connects to 127.0.0.1 for localhost, the default', () => {
    // Prod 2026-10-18: localhost raced ::1, which Podman's forwarder accepts and drops.
    expect(databaseHost(undefined)).toBe('127.0.0.1');
    expect(databaseHost('')).toBe('127.0.0.1');
    expect(databaseHost('localhost')).toBe('127.0.0.1');
    expect(databaseHost(' LocalHost ')).toBe('127.0.0.1');
  });

  it("uses an owner's own host or address exactly as set", () => {
    expect(databaseHost('10.10.0.40')).toBe('10.10.0.40');
    expect(databaseHost('db.internal.example')).toBe('db.internal.example');
    expect(databaseHost('::1')).toBe('::1');
    expect(databaseHost('fd00::12')).toBe('fd00::12');
    expect(databaseHost('/var/run/postgresql')).toBe('/var/run/postgresql');
  });
});
