import { describe, expect, it, vi } from 'vitest';

import {
  allocateDevServerPorts,
  type DevServerPortRequests,
  type PortAvailabilityCheck,
} from '../lib/dev-server-port-allocation';

function requests(overrides: Partial<DevServerPortRequests> = {}): DevServerPortRequests {
  return {
    backend: { port: 8080, envName: 'BACKEND_PORT', explicit: false },
    web: { port: 3000, envName: 'PORT', explicit: false },
    expoWeb: { port: 8082, envName: 'EXPO_WEB_PORT', explicit: false },
    ...overrides,
  };
}

function availability(occupiedPorts: ReadonlySet<number>): PortAvailabilityCheck {
  return vi.fn(async (port: number) => occupiedPorts.has(port));
}

describe('allocateDevServerPorts', () => {
  it('keeps Expo distinct when the backend fallback reaches the Expo default', async () => {
    const allocatedPorts = await allocateDevServerPorts(requests(), availability(new Set([8080, 8081])));

    expect(allocatedPorts).toEqual({
      backendPort: 8082,
      webPort: 3000,
      expoWebPort: 8083,
    });
  });

  it('reserves explicit ports before allocating automatic fallbacks', async () => {
    const allocatedPorts = await allocateDevServerPorts(
      requests({
        expoWeb: { port: 8081, envName: 'EXPO_WEB_PORT', explicit: true },
      }),
      availability(new Set([8080])),
    );

    expect(allocatedPorts).toEqual({
      backendPort: 8082,
      webPort: 3000,
      expoWebPort: 8081,
    });
  });

  it('keeps overlapping automatic service ranges distinct', async () => {
    const allocatedPorts = await allocateDevServerPorts(
      requests({
        web: { port: 8080, envName: 'PORT', explicit: false },
        expoWeb: { port: 8080, envName: 'EXPO_WEB_PORT', explicit: false },
      }),
      availability(new Set()),
    );

    expect(new Set(Object.values(allocatedPorts)).size).toBe(3);
    expect(allocatedPorts).toEqual({ backendPort: 8080, webPort: 8081, expoWebPort: 8082 });
  });

  it('rejects explicit ports assigned to more than one service', async () => {
    await expect(
      allocateDevServerPorts(
        requests({
          backend: { port: 8080, envName: 'BACKEND_PORT', explicit: true },
          expoWeb: { port: 8080, envName: 'EXPO_WEB_PORT', explicit: true },
        }),
        availability(new Set()),
      ),
    ).rejects.toThrow('Port 8080 is requested by both BACKEND_PORT and EXPO_WEB_PORT');
  });

  it('rejects an occupied explicit port', async () => {
    await expect(
      allocateDevServerPorts(
        requests({ backend: { port: 9090, envName: 'BACKEND_PORT', explicit: true } }),
        availability(new Set([9090])),
      ),
    ).rejects.toThrow('Port 9090 (BACKEND_PORT) is in use');
  });

  it('omits Expo allocation when Expo web is disabled', async () => {
    await expect(allocateDevServerPorts(requests({ expoWeb: null }), availability(new Set()))).resolves.toEqual({
      backendPort: 8080,
      webPort: 3000,
      expoWebPort: null,
    });
  });
});
