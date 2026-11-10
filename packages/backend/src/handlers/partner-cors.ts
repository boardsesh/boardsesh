/**
 * CORS for the partner OAuth routes. Separate from `applyCorsHeaders`, which
 * allows credentials and preview origins. `docs/integration-platform.md`,
 * "Browser access", sets the policy:
 *
 * - token and revoke never take credentials, and only the HTTPS origins of
 *   registered, live apps qualify;
 * - a successful response needs the origin of the authenticated app itself;
 * - an error may go to any registered origin, because an expired token can no
 *   longer identify its app and the browser still has to read the 401 or 429;
 * - consent is first-party: the one web origin, with credentials.
 */

const EXPOSED_RESPONSE_HEADERS =
  'Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, WWW-Authenticate, Sunset';
const PREFLIGHT_METHODS = 'GET, POST, DELETE';
const PREFLIGHT_REQUEST_HEADERS = 'Authorization, Content-Type, Idempotency-Key';
const PREFLIGHT_MAX_AGE_SECONDS = '600';

export interface PartnerOriginDirectory {
  isRegisteredOrigin(origin: string): Promise<boolean>;
  clientOwnsOrigin(clientId: string, origin: string): Promise<boolean>;
}

/** `credential-free` is token and revoke; `first-party` is consent. */
export type PartnerCorsPolicy = 'credential-free' | 'first-party';

export interface PartnerCorsRequest {
  policy: PartnerCorsPolicy;
  origin: string | undefined;
  webOrigin: string;
  directory: PartnerOriginDirectory;
}

/** Headers for an OPTIONS preflight. An ineligible origin gets `Vary` and nothing else, so the browser refuses. */
export async function partnerPreflightHeaders(request: PartnerCorsRequest): Promise<Record<string, string>> {
  const { policy, origin, webOrigin, directory } = request;
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (!origin) return headers;
  if (policy === 'first-party') {
    if (origin !== webOrigin) return headers;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Access-Control-Allow-Methods'] = 'POST';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
  } else {
    if (!(await directory.isRegisteredOrigin(origin))) return headers;
    headers['Access-Control-Allow-Methods'] = PREFLIGHT_METHODS;
    headers['Access-Control-Allow-Headers'] = PREFLIGHT_REQUEST_HEADERS;
  }
  headers['Access-Control-Allow-Origin'] = origin;
  headers['Access-Control-Max-Age'] = PREFLIGHT_MAX_AGE_SECONDS;
  return headers;
}

/** Headers for a real response. `clientId` is the app the request authenticated as, if any. */
export async function partnerResponseCorsHeaders(
  request: PartnerCorsRequest & { status: number; clientId: string | undefined },
): Promise<Record<string, string>> {
  const { policy, origin, webOrigin, directory, status, clientId } = request;
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (!origin) return headers;
  if (policy === 'first-party') {
    if (origin !== webOrigin) return headers;
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    return headers;
  }
  const succeeded = status >= 200 && status < 300;
  const eligible = succeeded
    ? clientId !== undefined && (await directory.clientOwnsOrigin(clientId, origin))
    : await directory.isRegisteredOrigin(origin);
  if (!eligible) return headers;
  headers['Access-Control-Allow-Origin'] = origin;
  headers['Access-Control-Expose-Headers'] = EXPOSED_RESPONSE_HEADERS;
  return headers;
}
