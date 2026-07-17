import { describe, expect, it } from 'vitest';

import { resolveDevServerOrigins } from '../lib/dev-server-origins';

describe('resolveDevServerOrigins', () => {
  it('uses Tailscale HTTPS and WSS publicly while keeping the Expo upstream on localhost HTTP', () => {
    expect(
      resolveDevServerOrigins({
        webPort: 3001,
        backendPort: 8081,
        expoWebPort: 8082,
        tlsHostname: 'dev-machine.example.ts.net',
      }),
    ).toEqual({
      publicWebOrigin: 'https://dev-machine.example.ts.net:3001',
      publicBackendOrigin: 'https://dev-machine.example.ts.net:8081',
      publicWebSocketUrl: 'wss://dev-machine.example.ts.net:8081/graphql',
      expoWebProxyOrigin: 'http://localhost:8082',
      expoWebAppUrl: 'https://dev-machine.example.ts.net:3001/app',
    });
  });

  it('falls back to localhost HTTP and WS when TLS is unavailable', () => {
    expect(
      resolveDevServerOrigins({
        webPort: 3000,
        backendPort: 8080,
        expoWebPort: 8082,
        tlsHostname: null,
      }),
    ).toEqual({
      publicWebOrigin: 'http://localhost:3000',
      publicBackendOrigin: 'http://localhost:8080',
      publicWebSocketUrl: 'ws://localhost:8080/graphql',
      expoWebProxyOrigin: 'http://localhost:8082',
      expoWebAppUrl: 'http://localhost:3000/app',
    });
  });

  it('omits Expo-specific origins for the standard web dev server', () => {
    const origins = resolveDevServerOrigins({
      webPort: 3000,
      backendPort: 8080,
      expoWebPort: null,
      tlsHostname: null,
    });

    expect(origins.expoWebProxyOrigin).toBeNull();
    expect(origins.expoWebAppUrl).toBeNull();
  });
});
