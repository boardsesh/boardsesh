/// <reference types="node" />

import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { resolveLanHosts } from '../resolve-lan-hosts';

const baseAddr: NetworkInterfaceInfo = {
  address: '0.0.0.0',
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: '0.0.0.0/24',
};

const makeInterfaces =
  (entries: Record<string, Partial<NetworkInterfaceInfo>[]>): (() => NodeJS.Dict<NetworkInterfaceInfo[]>) =>
  () =>
    Object.fromEntries(
      Object.entries(entries).map(([name, addrs]) => [
        name,
        addrs.map((addr) => ({ ...baseAddr, ...addr }) as NetworkInterfaceInfo),
      ]),
    );

describe('resolveLanHosts', () => {
  it('returns IPv4 non-internal addresses', () => {
    const result = resolveLanHosts({
      env: {},
      interfaces: makeInterfaces({
        en0: [{ address: '192.168.1.42' }],
      }),
    });
    expect(result).toEqual(['192.168.1.42']);
  });

  it('skips loopback / internal interfaces', () => {
    const result = resolveLanHosts({
      env: {},
      interfaces: makeInterfaces({
        lo0: [{ address: '127.0.0.1', internal: true }],
        en0: [{ address: '10.0.0.5' }],
      }),
    });
    expect(result).toEqual(['10.0.0.5']);
  });

  it('skips IPv6 addresses', () => {
    const result = resolveLanHosts({
      env: {},
      interfaces: makeInterfaces({
        en0: [{ address: 'fe80::1', family: 'IPv6' as NetworkInterfaceInfo['family'] }, { address: '192.168.0.10' }],
      }),
    });
    expect(result).toEqual(['192.168.0.10']);
  });

  it('skips 169.254/16 link-local addresses', () => {
    const result = resolveLanHosts({
      env: {},
      interfaces: makeInterfaces({
        en0: [{ address: '169.254.10.20' }, { address: '192.168.0.10' }],
      }),
    });
    expect(result).toEqual(['192.168.0.10']);
  });

  it('deduplicates repeated addresses across interfaces', () => {
    const result = resolveLanHosts({
      env: {},
      interfaces: makeInterfaces({
        en0: [{ address: '10.0.0.5' }],
        en1: [{ address: '10.0.0.5' }],
      }),
    });
    expect(result).toEqual(['10.0.0.5']);
  });

  it('short-circuits to [] when CI=1', () => {
    const result = resolveLanHosts({
      env: { CI: '1' },
      interfaces: makeInterfaces({ en0: [{ address: '10.0.0.5' }] }),
    });
    expect(result).toEqual([]);
  });

  it('short-circuits to [] under EAS_BUILD', () => {
    expect(
      resolveLanHosts({
        env: { EAS_BUILD: '1' },
        interfaces: makeInterfaces({ en0: [{ address: '10.0.0.5' }] }),
      }),
    ).toEqual([]);

    expect(
      resolveLanHosts({
        env: { EAS_BUILD_RUNNER: '1' },
        interfaces: makeInterfaces({ en0: [{ address: '10.0.0.5' }] }),
      }),
    ).toEqual([]);
  });

  it('returns [] when no interfaces match', () => {
    const result = resolveLanHosts({
      env: {},
      interfaces: makeInterfaces({
        lo0: [{ address: '127.0.0.1', internal: true }],
      }),
    });
    expect(result).toEqual([]);
  });
});
