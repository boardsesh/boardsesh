export type DevServerOrigins = {
  publicWebOrigin: string;
  publicBackendOrigin: string;
  publicWebSocketUrl: string;
  expoWebProxyOrigin: string | null;
  expoWebAppUrl: string | null;
};

type ResolveDevServerOriginsOptions = {
  webPort: number;
  backendPort: number;
  expoWebPort: number | null;
  tlsHostname: string | null;
};

export function resolveDevServerOrigins({
  webPort,
  backendPort,
  expoWebPort,
  tlsHostname,
}: ResolveDevServerOriginsOptions): DevServerOrigins {
  const publicHostname = tlsHostname ?? 'localhost';
  const httpScheme = tlsHostname ? 'https' : 'http';
  const websocketScheme = tlsHostname ? 'wss' : 'ws';
  const publicWebOrigin = `${httpScheme}://${publicHostname}:${webPort}`;

  return {
    publicWebOrigin,
    publicBackendOrigin: `${httpScheme}://${publicHostname}:${backendPort}`,
    publicWebSocketUrl: `${websocketScheme}://${publicHostname}:${backendPort}/graphql`,
    // Expo remains an internal HTTP upstream. Browsers only reach it through
    // Next's public /app origin, so this URL must never be exposed to the app.
    expoWebProxyOrigin: expoWebPort === null ? null : `http://localhost:${expoWebPort}`,
    expoWebAppUrl: expoWebPort === null ? null : `${publicWebOrigin}/app`,
  };
}
