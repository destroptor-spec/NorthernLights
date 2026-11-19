import net from 'net';
import os from 'os';

/**
 * Where a device is, for "gigs nearby" (Listen together, docs/listen-together.md,
 * Discovery): two devices are nearby when they have the same location.
 *
 * - The server's own LAN is one location, `lan`: every private address (it can
 *   only reach the server from the home network or its VPN, on any subnet or
 *   VLAN), and every IPv6 address in one of the server's own IPv6 networks (a
 *   device at home reaching the server through Cloudflare over IPv6).
 * - Elsewhere, an IPv6 address counts by its network (the /64): each device on
 *   a network has its own IPv6 address, but they share the /64.
 * - A public IPv4 address counts as itself: devices behind one router share it.
 */
export const SERVER_LAN = 'lan';

function ipv4Number(ip: string): number {
  return ip.split('.').reduce((value, part) => (value * 256) + Number(part), 0);
}

function inIpv4Range(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipv4Number(ip) & mask) >>> 0) === ((ipv4Number(base) & mask) >>> 0);
}

/** Private, loopback, link-local and the VPN range (100.64/10): only reach the server from its own network. */
function isLocalIpv4(ip: string): boolean {
  return inIpv4Range(ip, '10.0.0.0', 8)
    || inIpv4Range(ip, '172.16.0.0', 12)
    || inIpv4Range(ip, '192.168.0.0', 16)
    || inIpv4Range(ip, '127.0.0.0', 8)
    || inIpv4Range(ip, '169.254.0.0', 16)
    || inIpv4Range(ip, '100.64.0.0', 10);
}

/** The eight groups of an IPv6 address, written out ("::" expanded), lower case. */
export function ipv6Groups(ip: string): string[] | null {
  const address = ip.split('%')[0].toLowerCase();
  if (net.isIPv6(address) === false) return null;
  // An embedded IPv4 tail ("::ffff:1.2.3.4") becomes two groups.
  const v4 = address.match(/(\d+\.\d+\.\d+\.\d+)$/);
  let text = address;
  if (v4) {
    const n = ipv4Number(v4[1]);
    text = address.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = tail !== undefined ? [...headGroups, ...Array(missing).fill('0'), ...tailGroups] : headGroups;
  if (groups.length !== 8) return null;
  return groups.map((group) => parseInt(group, 16).toString(16));
}

/** The /64 an IPv6 address is in: its first four groups. */
function ipv6Network(ip: string): string | null {
  const groups = ipv6Groups(ip);
  return groups ? groups.slice(0, 4).join(':') : null;
}

/** Loopback, link-local (fe80::/10) and unique local (fc00::/7) IPv6. */
function isLocalIpv6(groups: string[]): boolean {
  const first = parseInt(groups[0], 16);
  if (groups.every((group, index) => (index === 7 ? group === '1' : group === '0'))) return true;
  return (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00;
}

const NETWORKS_TTL_MS = 60_000;
let serverNetworks: { at: number; v6: Set<string> } | null = null;

/** The server's own global IPv6 networks (/64), read from its interfaces (cached a minute). */
function serverIpv6Networks(): Set<string> {
  const now = Date.now();
  if (serverNetworks && now - serverNetworks.at < NETWORKS_TTL_MS) return serverNetworks.v6;
  const v6 = new Set<string>();
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal || address.family !== 'IPv6') continue;
      const groups = ipv6Groups(address.address);
      if (!groups || isLocalIpv6(groups)) continue;
      v6.add(groups.slice(0, 4).join(':'));
    }
  }
  serverNetworks = { at: now, v6 };
  return v6;
}

/** Tests: forget the cached interfaces. */
export function resetServerNetworks(): void {
  serverNetworks = null;
}

/** A device's location (see above), or null without a usable address. */
export function locationOf(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const address = ip.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (net.isIPv4(address)) return isLocalIpv4(address) ? SERVER_LAN : `v4:${address}`;
  const groups = ipv6Groups(address);
  if (!groups) return null;
  if (isLocalIpv6(groups)) return SERVER_LAN;
  const network = ipv6Network(address)!;
  return serverIpv6Networks().has(network) ? SERVER_LAN : `v6:${network}`;
}
