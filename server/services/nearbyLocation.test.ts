/** @jest-environment node */
import os from 'os';
import { ipv6Groups, locationOf, resetServerNetworks, SERVER_LAN } from './nearbyLocation';

const interfaces = jest.spyOn(os, 'networkInterfaces');

beforeEach(() => {
  resetServerNetworks();
  // The server: 10.10.0.12 on its LAN, and a global IPv6 address in 2a05:f6c7:1234:10::/64.
  interfaces.mockReturnValue({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as os.NetworkInterfaceInfo],
    eth0: [
      { address: '10.10.0.12', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo,
      { address: '2a05:f6c7:1234:10:be24:11ff:fe2a:9c01', family: 'IPv6', internal: false } as os.NetworkInterfaceInfo,
      { address: 'fe80::be24:11ff:fe2a:9c01', family: 'IPv6', internal: false } as os.NetworkInterfaceInfo,
    ],
  });
});

describe('locationOf', () => {
  it('puts every private address in the server\'s LAN, whatever its subnet or VLAN', () => {
    for (const ip of ['10.10.0.57', '10.20.5.3', '192.168.1.20', '172.20.0.4', '100.101.102.103', '127.0.0.1', '::ffff:10.10.0.57', '::1', 'fd12:3456::7', 'fe80::1%eth0']) {
      expect([ip, locationOf(ip)]).toEqual([ip, SERVER_LAN]);
    }
  });

  it("puts an IPv6 address in the server's own network in its LAN (at home, through Cloudflare)", () => {
    expect(locationOf('2a05:f6c7:1234:10:1c2b:aaaa:bbbb:cccc')).toBe(SERVER_LAN);
    expect(locationOf('2a05:f6c7:1234:10::42')).toBe(SERVER_LAN);
  });

  it('puts other IPv6 addresses on one network together, by its /64', () => {
    const phone = locationOf('2001:db8:aa:bb:1111:2222:3333:4444');
    const laptop = locationOf('2001:db8:aa:bb::99');
    expect(phone).toBe('v6:2001:db8:aa:bb');
    expect(laptop).toBe(phone);
    expect(locationOf('2001:db8:aa:cc::1')).not.toBe(phone);
  });

  it('keeps a public IPv4 address as itself', () => {
    expect(locationOf('203.0.113.7')).toBe('v4:203.0.113.7');
    expect(locationOf('::ffff:203.0.113.7')).toBe('v4:203.0.113.7');
  });

  it('has no location without a usable address', () => {
    expect(locationOf(null)).toBeNull();
    expect(locationOf('')).toBeNull();
    expect(locationOf('unknown')).toBeNull();
  });
});

it('writes IPv6 addresses out in full', () => {
  expect(ipv6Groups('2001:DB8::1')).toEqual(['2001', 'db8', '0', '0', '0', '0', '0', '1']);
  expect(ipv6Groups('::')).toEqual(['0', '0', '0', '0', '0', '0', '0', '0']);
  expect(ipv6Groups('::ffff:10.0.0.1')).toEqual(['0', '0', '0', '0', '0', 'ffff', 'a00', '1']);
});
