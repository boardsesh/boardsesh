import { eq } from 'drizzle-orm';
import { oauthAccessToken, oauthClient, oauthConnections, oauthGrants, oauthSession } from '@boardsesh/db/schema/auth';
import type { PartnerDatabase } from './tables';

/**
 * Who a `/v1` request acts for, as its access token says. Read from the
 * primary on every request, never cached, so Disconnect, a password reset or a
 * suspended app takes effect on the next call.
 */
export interface PartnerApiPrincipal {
  clientId: string;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  scopes: string[];
  /** The stored hash, so a write can check the token again under its lock. */
  accessTokenHash: string;
  /** The connection's `last_used_at` as read, so a request writes it only when it is an hour old. */
  connectionLastUsedAt: Date | null;
}

/** Why a token was refused. For logs only: every reason answers the same 401. */
export type PartnerBearerRefusal =
  | 'unknown'
  | 'expired'
  | 'revoked'
  | 'sender_constrained'
  | 'wrong_audience'
  | 'client_disabled'
  | 'session_ended'
  | 'connection_mismatch'
  | 'connection_revoked'
  | 'stale_generation';

export type PartnerBearerResult =
  | { principal: PartnerApiPrincipal; refusal?: undefined }
  | { principal?: undefined; refusal: PartnerBearerRefusal };

type PartnerBearerRow = {
  clientId: string;
  userId: string | null;
  scopes: string[];
  resources: string[] | null;
  expiresAt: Date;
  revoked: Date | null;
  confirmation: unknown;
  sessionId: string | null;
  sessionExpiresAt: Date | null;
  grantGeneration: number;
  connectionId: string;
  connectionUserId: string;
  connectionClientId: string;
  connectionGeneration: number;
  connectionRevokedAt: Date | null;
  connectionLastUsedAt: Date | null;
  clientDisabled: boolean | null;
};

/**
 * Every check the provider's own introspection makes (unknown, expired,
 * revoked, disabled client, ended session), plus what makes a token usable on
 * this API: it names this resource, and its grant is the connection's current
 * generation on a connection that is not revoked. A token issued with no
 * `resource` has no audience and never passes. A sender-constrained (DPoP)
 * token is refused because this API does not check proofs.
 */
export function judgePartnerBearer(
  row: PartnerBearerRow | undefined,
  { accessTokenHash, resource, now }: { accessTokenHash: string; resource: string; now: Date },
): PartnerBearerResult {
  if (!row || row.userId === null) return { refusal: 'unknown' };
  if (row.expiresAt.getTime() <= now.getTime()) return { refusal: 'expired' };
  if (row.revoked !== null) return { refusal: 'revoked' };
  if (row.confirmation !== null && row.confirmation !== undefined) return { refusal: 'sender_constrained' };
  if (!row.resources?.includes(resource)) return { refusal: 'wrong_audience' };
  if (row.clientDisabled === true) return { refusal: 'client_disabled' };
  if (row.sessionId !== null && (row.sessionExpiresAt === null || row.sessionExpiresAt.getTime() <= now.getTime())) {
    return { refusal: 'session_ended' };
  }
  if (row.connectionUserId !== row.userId || row.connectionClientId !== row.clientId) {
    return { refusal: 'connection_mismatch' };
  }
  if (row.connectionRevokedAt !== null) return { refusal: 'connection_revoked' };
  if (row.grantGeneration !== row.connectionGeneration) return { refusal: 'stale_generation' };
  return {
    principal: {
      clientId: row.clientId,
      userId: row.userId,
      connectionId: row.connectionId,
      connectionGeneration: row.connectionGeneration,
      scopes: row.scopes,
      accessTokenHash,
      connectionLastUsedAt: row.connectionLastUsedAt,
    },
  };
}

/**
 * Looks up a presented access token by its stored hash, in one read that takes
 * no lock. The grant join is what ties the token to a connection generation, so
 * a token whose grant row is gone fails closed.
 */
export async function findPartnerApiPrincipal(
  database: PartnerDatabase,
  { accessTokenHash, resource, now = new Date() }: { accessTokenHash: string; resource: string; now?: Date },
): Promise<PartnerBearerResult> {
  const [row] = await database
    .select({
      clientId: oauthAccessToken.clientId,
      userId: oauthAccessToken.userId,
      scopes: oauthAccessToken.scopes,
      resources: oauthAccessToken.resources,
      expiresAt: oauthAccessToken.expiresAt,
      revoked: oauthAccessToken.revoked,
      confirmation: oauthAccessToken.confirmation,
      sessionId: oauthAccessToken.sessionId,
      sessionExpiresAt: oauthSession.expiresAt,
      grantGeneration: oauthGrants.generation,
      connectionId: oauthConnections.id,
      connectionUserId: oauthConnections.userId,
      connectionClientId: oauthConnections.clientId,
      connectionGeneration: oauthConnections.generation,
      connectionRevokedAt: oauthConnections.revokedAt,
      connectionLastUsedAt: oauthConnections.lastUsedAt,
      clientDisabled: oauthClient.disabled,
    })
    .from(oauthAccessToken)
    .innerJoin(oauthGrants, eq(oauthGrants.authorizationCodeId, oauthAccessToken.authorizationCodeId))
    .innerJoin(oauthConnections, eq(oauthConnections.id, oauthGrants.connectionId))
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthAccessToken.clientId))
    .leftJoin(oauthSession, eq(oauthSession.id, oauthAccessToken.sessionId))
    .where(eq(oauthAccessToken.token, accessTokenHash))
    .limit(1);
  return judgePartnerBearer(row, { accessTokenHash, resource, now });
}
