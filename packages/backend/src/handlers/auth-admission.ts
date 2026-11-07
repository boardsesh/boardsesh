import type { ServerResponse } from 'node:http';
import { isAuthAdmissionUnavailable } from '../auth/human-admission';
import { validateToken, type AuthResult } from '../middleware/auth';
import { sendJson } from './http-utils';

export type HttpAuthAdmission = { available: true; auth: AuthResult | null } | { available: false };

/** An unavailable response is terminal; callers must not replace it with 401. */
export async function validateHttpAuthToken(token: string, response: ServerResponse): Promise<HttpAuthAdmission> {
  try {
    return { available: true, auth: await validateToken(token) };
  } catch (error) {
    if (!isAuthAdmissionUnavailable(error)) throw error;
    sendJson(response, 503, { error: 'Authentication is temporarily unavailable' }, { 'Retry-After': '1' });
    return { available: false };
  }
}
