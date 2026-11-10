import { and, eq, inArray } from 'drizzle-orm';
import {
  oauthAccessToken,
  oauthConnections,
  oauthConsent,
  oauthGrants,
  oauthRefreshAncestors,
  oauthRefreshToken,
  oauthVerification,
} from '@boardsesh/db/schema/auth';
import { lockPartnerConnection } from './locks';
import { runInPartnerTransaction } from './transaction';
import type { PartnerDatabase } from './tables';

export type PartnerDisconnectReason = 'climber_disconnect' | 'app_disconnect';

/**
 * Ends one climber's connection to one app: the generation goes up, so nothing
 * issued under the old one can work again, and every token, remembered consent,
 * ancestor and pending code goes. Returns false when there was nothing to end.
 * Account-wide revocation does the same for every connection in the database
 * trigger (`partner_revoke_user`).
 */
export async function disconnectPartnerConnection(
  database: PartnerDatabase,
  { userId, clientId, reason }: { userId: string; clientId: string; reason: PartnerDisconnectReason },
): Promise<boolean> {
  return runInPartnerTransaction(database, async (transaction) => {
    const connection = await lockPartnerConnection(transaction, userId, clientId);
    if (!connection || connection.revokedAt) return false;

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
    return true;
  });
}
