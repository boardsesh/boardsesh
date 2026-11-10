import { and, count, eq, gt, isNotNull, isNull, ne } from 'drizzle-orm';
import { oauthAppPolicy, oauthConnections } from '@boardsesh/db/schema/auth';
import type { PartnerDatabase } from './tables';

const DAY_MS = 24 * 60 * 60 * 1000;

export type ConnectionCapRefusal = 'no_policy' | 'active_connections' | 'new_connections_today';

/**
 * Decision 22: an app holds at most `max_active_connections` live connections
 * and gains at most `max_new_connections_per_day` in any 24 hours (25 and 20 by
 * default). A connection counts once the app has redeemed a code for it
 * (`connected_at` set); an approval nobody redeemed does not, so throwaway
 * approvals cannot fill an app. A reconnect counts as a new connection for the
 * day.
 *
 * Call it with the connection row locked, just before that connection becomes
 * live (and, as an early answer, when the climber approves). It locks the app's
 * policy row until the transaction ends, so two connections going live at once
 * count one after the other and cannot both take the last place. The order is
 * the issuer's: `users`, connection, then policy. An app with no policy row
 * cannot gain connections.
 */
export async function checkConnectionCaps(
  transaction: PartnerDatabase,
  connection: { id: string; clientId: string },
  connectingAt: Date,
): Promise<ConnectionCapRefusal | null> {
  const [policy] = await transaction
    .select({
      maxActiveConnections: oauthAppPolicy.maxActiveConnections,
      maxNewConnectionsPerDay: oauthAppPolicy.maxNewConnectionsPerDay,
    })
    .from(oauthAppPolicy)
    .where(eq(oauthAppPolicy.clientId, connection.clientId))
    .for('no key update');
  if (!policy) return 'no_policy';

  const otherApprovedConnections = and(
    eq(oauthConnections.clientId, connection.clientId),
    ne(oauthConnections.id, connection.id),
    isNotNull(oauthConnections.connectedAt),
  );
  const [active] = await transaction
    .select({ connections: count() })
    .from(oauthConnections)
    .where(and(otherApprovedConnections, isNull(oauthConnections.revokedAt)));
  if ((active?.connections ?? 0) >= policy.maxActiveConnections) return 'active_connections';

  const [today] = await transaction
    .select({ connections: count() })
    .from(oauthConnections)
    .where(and(otherApprovedConnections, gt(oauthConnections.connectedAt, new Date(connectingAt.getTime() - DAY_MS))));
  if ((today?.connections ?? 0) >= policy.maxNewConnectionsPerDay) return 'new_connections_today';
  return null;
}
