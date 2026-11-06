import type { IncomingMessage } from 'http';
import { validateToken } from '../middleware/auth';
import { isAuthAdmissionUnavailable } from '../auth/human-admission';

export type SessionAuthResult = { ok: true; userId: string } | { ok: false; status: 401 | 503; error: string };

/**
 * Authenticate a stateless HTTP session request by its `Authorization: Bearer`
 * token. Accepts either token family the backend issues — the web NextAuth JWE
 * (5 segments) or the mobile/watch JWS (3 segments) — via `validateToken`, and
 * resolves the caller's `userId`.
 *
 * This is the JWT counterpart of the iOS widget's `authenticateWidget` (which
 * authenticates by a registered APNs push-token row). The Garmin watch holds a
 * mobile JWT minted through `/api/watch/pair`, so it authenticates here instead.
 */
export async function authenticateSessionRequest(req: IncomingMessage): Promise<SessionAuthResult> {
  const authHeader = req.headers['authorization'];
  const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!headerValue || !headerValue.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  const token = headerValue.slice(7).trim();
  if (!token) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  try {
    const auth = await validateToken(token);
    if (!auth) return { ok: false, status: 401, error: 'Unauthorized' };
    return { ok: true, userId: auth.userId };
  } catch (error) {
    if (!isAuthAdmissionUnavailable(error)) throw error;
    return { ok: false, status: 503, error: 'Authentication is temporarily unavailable' };
  }
}
