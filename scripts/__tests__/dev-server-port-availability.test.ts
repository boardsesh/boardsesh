import { createServer, type Server } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { classifyDevServerPortBindError, isDevServerPortInUse } from '../lib/dev-server-port-availability';

const openServers: Server[] = [];

async function listenOnIpv6Loopback(): Promise<{ port: number } | null> {
  const server = createServer();
  openServers.push(server);

  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL') {
        resolve(null);
        return;
      }
      reject(error);
    });
    server.listen({ host: '::1', port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('IPv6 listener did not expose a TCP port'));
        return;
      }
      resolve({ port: address.port });
    });
  });
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('isDevServerPortInUse', () => {
  it('detects an IPv6 loopback listener that would block the backend wildcard bind', async () => {
    const listener = await listenOnIpv6Loopback();
    if (!listener) return;

    await expect(isDevServerPortInUse(listener.port)).resolves.toBe(true);
  });

  it('releases its probe listener when a port is available', async () => {
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => resolve());
    });
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Reservation did not expose a TCP port');
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));

    await expect(isDevServerPortInUse(port)).resolves.toBe(false);

    const replacement = createServer();
    openServers.push(replacement);
    await expect(
      new Promise<void>((resolve, reject) => {
        replacement.once('error', reject);
        replacement.listen({ port, exclusive: true }, () => resolve());
      }),
    ).resolves.toBeUndefined();
  });

  it('treats permission failures as unavailable instead of falling back to a connection probe', () => {
    expect(classifyDevServerPortBindError(Object.assign(new Error('permission denied'), { code: 'EPERM' }))).toBe(
      'unavailable',
    );
    expect(classifyDevServerPortBindError(Object.assign(new Error('access denied'), { code: 'EACCES' }))).toBe(
      'unavailable',
    );
    expect(classifyDevServerPortBindError(Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }))).toBe('in-use');
  });
});
