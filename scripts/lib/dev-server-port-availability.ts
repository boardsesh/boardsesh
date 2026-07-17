/// <reference types="node" />
import { createConnection, createServer } from 'node:net';

type PortBindResult = 'available' | 'in-use' | 'fallback-probe';

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export function classifyDevServerPortBindError(error: unknown): Exclude<PortBindResult, 'available'> {
  const errorCode = getErrorCode(error);
  if (errorCode === 'EADDRINUSE') return 'in-use';
  return 'fallback-probe';
}

async function checkDefaultPortBind(port: number): Promise<PortBindResult> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error: unknown) => {
      resolve(classifyDevServerPortBindError(error));
    });
    server.once('listening', () => {
      server.close(() => {
        resolve('available');
      });
    });

    // Match the backend's `server.listen(port)` bind. On hosts with IPv6 this
    // uses the dual-stack `::` wildcard, so it detects IPv6 loopback listeners
    // such as Expo's `[::1]:8082` as well as IPv4 listeners.
    server.listen({ port, exclusive: true });
  });
}

async function isLocalhostPortInUse(port: number, timeout = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: 'localhost' }, () => {
      socket.destroy();
      resolve(true);
    });

    socket.setTimeout(timeout);
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      resolve(false);
    });
  });
}

/** Check whether a port can accept a backend-style wildcard listener. */
export async function isDevServerPortInUse(port: number): Promise<boolean> {
  const bindResult = await checkDefaultPortBind(port);
  return resolveDevServerPortInUse(bindResult, () => isLocalhostPortInUse(port));
}

export async function resolveDevServerPortInUse(
  bindResult: PortBindResult,
  fallbackProbe: () => Promise<boolean>,
): Promise<boolean> {
  if (bindResult === 'available') return false;
  if (bindResult === 'in-use') return true;
  return fallbackProbe();
}
