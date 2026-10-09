import {
  CLIENT_IDENTITY_CONNECTION_PARAM,
  CLIENT_IDENTITY_HEADER,
  formatClientIdentity,
} from '@boardsesh/shared-schema/client-identity';

/**
 * www's `x-boardsesh-client` identity, so the backend can tell this site's
 * traffic apart from the apps and from third-party clients. Identification
 * only: the backend gates nothing on it. Contract:
 * packages/shared-schema/src/client-identity.ts.
 *
 * Browser calls send `boardsesh-web/<version>`; calls made from the Next server
 * (server components, route handlers) add a `(server)` platform so SSR traffic
 * reads separately in logs.
 */

export const WEB_CLIENT_NAME = 'boardsesh-web';

/**
 * Mirrors the `version` in packages/web/package.json, which a unit test pins.
 * Hard-coded rather than imported so the browser bundle never carries the
 * whole package.json.
 */
export const WEB_CLIENT_VERSION = '0.1.0';

export function getWebClientIdentity(): string {
  return formatClientIdentity({
    name: WEB_CLIENT_NAME,
    version: WEB_CLIENT_VERSION,
    platform: typeof window === 'undefined' ? 'server' : undefined,
  });
}

/** Spread into the headers of any HTTP request to the backend. */
export function webClientIdentityHeaders(): Record<string, string> {
  return { [CLIENT_IDENTITY_HEADER]: getWebClientIdentity() };
}

/** Merge into WebSocket connectionParams (browsers cannot set upgrade headers). */
export function webClientIdentityConnectionParams(): Record<string, string> {
  return { [CLIENT_IDENTITY_CONNECTION_PARAM]: getWebClientIdentity() };
}
