import { and, eq, inArray } from 'drizzle-orm';
import {
  oauthAccessToken,
  oauthConnections,
  oauthConsent,
  oauthConsentInteractions,
  oauthGrants,
  oauthRefreshAncestors,
  oauthRefreshToken,
  oauthVerification,
} from '@boardsesh/db/schema/auth';
import { lockPartnerConnection } from './locks';
import { runInPartnerTransaction } from './transaction';
import type { PartnerDatabase } from './tables';

export type PartnerDisconnectReason = 'climber_disconnect' | 'app_disconnect';

type OAuthConnection = typeof oauthConnections.$inferSelect;

/**
 * Ends a connection the caller has already locked (`lockPartnerConnection`):
 * the generation goes up, so nothing issued under the old one can work again,
 * and every token, remembered consent, refresh ancestor, pending consent screen
 * and pending code goes. Ancestry goes with the tokens: the family guard refuses
 * a fenced grant without closing its family, so a leftover ancestor would make
 * every replay of it take the climber's row lock. Account-wide revocation does
 * the same for every connection in the database trigger (`partner_revoke_user`).
 */
export async function endPartnerConnection(
  transaction: PartnerDatabase,
  connection: OAuthConnection,
  reason: PartnerDisconnectReason,
): Promise<void> {
  const { userId, clientId } = connection;
  const revokedAt = new Date();
  await transaction
    .update(oauthConnections)
    .set({ generation: connection.generation + 1, revokedAt, revocationReason: reason, updatedAt: revokedAt })
    .where(eq(oauthConnections.id, connection.id));
  await transaction
    .delete(oauthAccessToken)
    .where(and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, clientId)));
  await transaction
    .delete(oauthRefreshToken)
    .where(and(eq(oauthRefreshToken.userId, userId), eq(oauthRefreshToken.clientId, clientId)));
  await transaction
    .delete(oauthConsent)
    .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)));
  await transaction
    .delete(oauthRefreshAncestors)
    .where(and(eq(oauthRefreshAncestors.userId, userId), eq(oauthRefreshAncestors.clientId, clientId)));
  // A consent answer locks its link, then this connection, the opposite of
  // this function's order, so a link locked now is skipped rather than waited
  // for. Skipping is safe: that answer is waiting on this connection's lock,
  // and once this commits it reads the raised generation, which no longer
  // matches the one its link was opened against, so it approves nothing. The
  // skipped link stays behind with that old generation. A generation only
  // ever rises, so the link can never match again and is only swept on expiry.
  await transaction.delete(oauthConsentInteractions).where(
    inArray(
      oauthConsentInteractions.digest,
      transaction
        .select({ digest: oauthConsentInteractions.digest })
        .from(oauthConsentInteractions)
        .where(and(eq(oauthConsentInteractions.userId, userId), eq(oauthConsentInteractions.clientId, clientId)))
        .for('update', { skipLocked: true }),
    ),
  );

  const grants = await transaction
    .select({ authorizationCodeId: oauthGrants.authorizationCodeId })
    .from(oauthGrants)
    .where(eq(oauthGrants.connectionId, connection.id));
  if (grants.length > 0) {
    await transaction.delete(oauthVerification).where(
      inArray(
        oauthVerification.identifier,
        grants.map((grant) => grant.authorizationCodeId),
      ),
    );
  }
  await transaction.delete(oauthGrants).where(eq(oauthGrants.connectionId, connection.id));
}

/**
 * Ends one climber's connection to one app. Returns false when there was
 * nothing to end.
 */
export async function disconnectPartnerConnection(
  database: PartnerDatabase,
  { userId, clientId, reason }: { userId: string; clientId: string; reason: PartnerDisconnectReason },
): Promise<boolean> {
  return runInPartnerTransaction(database, async (transaction) => {
    const connection = await lockPartnerConnection(transaction, userId, clientId);
    if (!connection || connection.revokedAt) return false;
    await endPartnerConnection(transaction, connection, reason);
    return true;
  });
}
