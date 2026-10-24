/**
 * The database host to connect to: DB_HOST exactly as the owner set it (a
 * host name or any IPv4/IPv6 address), except "localhost", the default, which
 * means 127.0.0.1.
 *
 * Node resolves localhost to ::1 and 127.0.0.1 and races them. Rootless
 * Podman publishes the database port on IPv4 only, but its port forwarder
 * accepts the IPv6 connection and then drops it, so now and then a new pool
 * connection died ("Connection terminated unexpectedly") and every query
 * waiting for one stalled. Prod 2026-10-18: twice in a morning, the health
 * check timed out and the app showed the database recovery screen while
 * music played. A database on IPv6 loopback only is set as DB_HOST=::1.
 */
export function databaseHost(configured: string | undefined = process.env.DB_HOST): string {
  const host = configured?.trim() || 'localhost';
  return host.toLowerCase() === 'localhost' ? '127.0.0.1' : host;
}
