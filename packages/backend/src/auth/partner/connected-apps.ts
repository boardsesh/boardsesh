import { and, desc, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  oauthAccessToken,
  oauthAppPolicy,
  oauthClient,
  oauthConnections,
  oauthConsent,
  oauthRefreshToken,
  oauthMcpClientPolicy,
} from '@boardsesh/db/schema/auth';
import { endPartnerConnection } from './connection';
import { lockPartnerConnection } from './locks';
import type { PartnerDatabase } from './tables';
import { isPartnerDatabaseBusy, runInPartnerTransaction } from './transaction';

/**
 * Connected apps: the climber's own list of live connections and their
 * Disconnect. Plain SQL on the partner tables and nothing from Better Auth, so
 * both work whatever PARTNER_OAUTH_MODE says. A climber can always see and end
 * a connection, including one made before the mode was turned off.
 */

/** One live connection, as the climber's settings show it. */
export interface ConnectedAppRecord {
  connectionId: string;
  name: string | null;
  /** Who makes the app, from its registration; null for an app registered before it was required. */
  publisherName: string | null;
  /**
   * What the app can read: the scopes of the remembered consent and of every
   * live token it holds, together. Consent scopes come first, in their order.
   */
  scopes: string[];
  connectedAt: Date;
  lastUsedAt: Date | null;
  /** Suspended by Boardsesh (`oauth_client.disabled`, or a policy suspension). */
  suspended: boolean;
}

/** `busy`: a lock did not come within 2 s or a statement ran over 5 s. Nothing changed; try again. */
export type ConnectedAppDisconnectOutcome = 'disconnected' | 'already_disconnected' | 'not_found' | 'busy';

/**
 * The climber's live connections, most recently connected first. Live means the
 * app has redeemed a code (`connected_at`) and the climber has not disconnected
 * it since. An approval nobody redeemed is not a connection yet, the same rule
 * the caps count by.
 */
export async function listConnectedApps(database: PartnerDatabase, userId: string): Promise<ConnectedAppRecord[]> {
  const connections = await database
    .select({
      connectionId: oauthConnections.id,
      clientId: oauthConnections.clientId,
      connectionScopes: oauthConnections.scopes,
      connectedAt: oauthConnections.connectedAt,
      lastUsedAt: oauthConnections.lastUsedAt,
      name: oauthClient.name,
      publisherName: oauthAppPolicy.publisherName,
      disabled: oauthClient.disabled,
      suspendedAt: oauthAppPolicy.suspendedAt,
      mcpSuspendedAt: oauthMcpClientPolicy.suspendedAt,
    })
    .from(oauthConnections)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConnections.clientId))
    .leftJoin(oauthAppPolicy, eq(oauthAppPolicy.clientId, oauthConnections.clientId))
    .leftJoin(oauthMcpClientPolicy, eq(oauthMcpClientPolicy.clientId, oauthConnections.clientId))
    .where(
      and(
        eq(oauthConnections.userId, userId),
        isNotNull(oauthConnections.connectedAt),
        isNull(oauthConnections.revokedAt),
      ),
    )
    .orderBy(desc(oauthConnections.connectedAt), oauthConnections.id);
  if (connections.length === 0) return [];

  const clientIds = connections.map((connection) => connection.clientId);
  const scopesByClient = new Map<string, Set<string>>();
  const addScopes = (clientId: string, scopes: readonly string[]) => {
    const known = scopesByClient.get(clientId) ?? new Set<string>();
    for (const scope of scopes) known.add(scope);
    scopesByClient.set(clientId, known);
  };

  // The provider writes one consent row per climber and app and rewrites it in
  // place; the newest wins should there ever be two.
  const consents = await database
    .select({ clientId: oauthConsent.clientId, scopes: oauthConsent.scopes })
    .from(oauthConsent)
    .where(and(eq(oauthConsent.userId, userId), inArray(oauthConsent.clientId, clientIds)))
    .orderBy(desc(oauthConsent.updatedAt));
  const consentRead = new Set<string>();
  for (const consent of consents) {
    if (consentRead.has(consent.clientId)) continue;
    consentRead.add(consent.clientId);
    addScopes(consent.clientId, consent.scopes);
  }

  // What the app can read is also whatever its live tokens carry. That can be
  // wider than the consent, after the climber approved fewer scopes on a second
  // device, and it is all there is while no consent is remembered (the app
  // gained a redirect URI since, registration.ts). An app with neither holds no
  // credential that reads anything, and the list says so.
  const now = new Date();
  const liveTokenScopes = (table: typeof oauthRefreshToken | typeof oauthAccessToken) =>
    database
      .select({ clientId: table.clientId, scopes: table.scopes })
      .from(table)
      .where(
        and(
          eq(table.userId, userId),
          inArray(table.clientId, clientIds),
          isNull(table.revoked),
          gt(table.expiresAt, now),
        ),
      );
  for (const token of [...(await liveTokenScopes(oauthRefreshToken)), ...(await liveTokenScopes(oauthAccessToken))]) {
    addScopes(token.clientId, token.scopes);
  }

  return connections.map((connection) => ({
    connectionId: connection.connectionId,
    name: connection.name?.trim() || null,
    publisherName: connection.publisherName?.trim() || null,
    scopes: [...new Set([...(scopesByClient.get(connection.clientId) ?? []), ...connection.connectionScopes])],
    // Filtered on above; the column is nullable only for approvals not yet redeemed.
    connectedAt: connection.connectedAt as Date,
    lastUsedAt: connection.lastUsedAt,
    suspended: connection.disabled === true || connection.suspendedAt !== null || Boolean(connection.mcpSuspendedAt),
  }));
}

/**
 * Ends one of the climber's connections, by the id Connected apps listed. The
 * same path as `DELETE /v1/connection` (`endPartnerConnection`) in the same
 * lock order: the climber's `users` row FOR SHARE, then the connection FOR
 * UPDATE, then the provider rows, with consent links skipped when locked. The
 * id is matched to the climber before any lock and again under it, so another
 * climber's id finds nothing and ends nothing. A connection that has not gone
 * live yet (an approved reconnect the app never redeemed) is ended too: the
 * climber asked for it to be gone.
 */
export async function disconnectConnectedApp(
  database: PartnerDatabase,
  { userId, connectionId }: { userId: string; connectionId: string },
): Promise<ConnectedAppDisconnectOutcome> {
  const [owned] = await database
    .select({ clientId: oauthConnections.clientId })
    .from(oauthConnections)
    .where(and(eq(oauthConnections.id, connectionId), eq(oauthConnections.userId, userId)));
  if (!owned) return 'not_found';

  try {
    return await runInPartnerTransaction(database, async (transaction) => {
      const connection = await lockPartnerConnection(transaction, userId, owned.clientId);
      if (!connection || connection.id !== connectionId) return 'not_found';
      if (connection.revokedAt) return 'already_disconnected';
      await endPartnerConnection(transaction, connection, 'climber_disconnect');
      return 'disconnected';
    });
  } catch (error) {
    if (isPartnerDatabaseBusy(error)) return 'busy';
    throw error;
  }
}
