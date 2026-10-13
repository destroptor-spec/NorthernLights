/**
 * An RFC 4122 v4 UUID, valid in any browsing context.
 *
 * API v1 validates idempotency keys such as a playback report's `eventId` as
 * UUIDs. `crypto.randomUUID` exists only in secure contexts, so a client on
 * plain http (a LAN IP, say) would otherwise fall back to a non-UUID and have
 * every report rejected — plays silently not counted. `getRandomValues` is
 * available everywhere.
 */
export function createUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Whether `value` is an RFC 4122 UUID, the only entry-ID form API v1 accepts. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
