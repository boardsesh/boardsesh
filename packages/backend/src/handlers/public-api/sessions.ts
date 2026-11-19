import { z } from 'zod';
import { PartnerSessionSchema } from '@boardsesh/public-api';
import { PARTNER_SESSION_TOO_LARGE_MESSAGE, PartnerSessionReadTooLarge } from '../../services/public-api/sessions';
import { CHALLENGE_INVALID_TOKEN, errorOutcome, unauthorized, unavailable, type ApiOutcome } from './outcome';
import type { PartnerRuntime } from './router';

type PartnerApiPrincipal = Parameters<PartnerRuntime['api']['readClimber']>[0];

export async function serveLogbookSession(
  runtime: PartnerRuntime,
  principal: PartnerApiPrincipal,
  sessionId: string | undefined,
  requestId: string,
): Promise<ApiOutcome> {
  if (!principal.scopes.includes('logbook:read') || !principal.scopes.includes('sessions:read'))
    return errorOutcome(403, 'insufficient_scope', 'This call needs logbook:read sessions:read.', requestId, {
      headers: { 'www-authenticate': 'Bearer error="insufficient_scope", scope="logbook:read sessions:read"' },
    });
  const exportId = z.uuid().safeParse(sessionId);
  if (!exportId.success) return errorOutcome(404, 'not_found', 'Session not found.', requestId);
  try {
    const session = await runtime.logbook.readSession(principal, exportId.data);
    return session
      ? { status: 200, body: PartnerSessionSchema.parse(session) }
      : errorOutcome(404, 'not_found', 'Session not found.', requestId);
  } catch (error) {
    if (runtime.logbook.isConnectionEnded(error))
      return unauthorized(requestId, CHALLENGE_INVALID_TOKEN, 'connection_ended');
    if (error instanceof PartnerSessionReadTooLarge)
      return unavailable(requestId, { retryAfterSeconds: 60, message: PARTNER_SESSION_TOO_LARGE_MESSAGE });
    throw error;
  }
}
