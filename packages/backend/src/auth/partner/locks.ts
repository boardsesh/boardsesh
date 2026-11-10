import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { oauthClient, oauthConnections, oauthConsentInteractions, oauthGrants, users } from '@boardsesh/db/schema/auth';
import type { FamilyOwner } from './family-guard';
import type { PartnerDatabase } from './tables';
import { getPostgresErrorCode } from '../../utils/postgres-errors';

type OAuthConnection = typeof oauthConnections.$inferSelect;

/**
 * Lock order, always: the climber's `users` row FOR SHARE, then the connection
 * row FOR UPDATE, then provider rows. FOR SHARE leaves the FOR KEY SHARE that
 * foreign-key inserts take alone, but conflicts with the FOR NO KEY UPDATE a
 * password reset takes and the FOR UPDATE an account deletion takes, so both
 * wait for issuers in flight. Issuers never write `users`, so two of them
 * holding FOR SHARE cannot deadlock on an upgrade.
 */
export async function lockClimber(database: PartnerDatabase, userId: string): Promise<boolean> {
  const climbers = await database.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('share');
  return climbers.length === 1;
}

/** Call with the climber already locked, so the order above holds. */
export async function selectConnectionForUpdate(
  database: PartnerDatabase,
  userId: string,
  clientId: string,
): Promise<OAuthConnection | undefined> {
  const [connection] = await database
    .select()
    .from(oauthConnections)
    .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.clientId, clientId)))
    .for('update');
  return connection;
}

export async function lockPartnerConnection(
  database: PartnerDatabase,
  userId: string,
  clientId: string,
): Promise<OAuthConnection | null> {
  if (!(await lockClimber(database, userId))) return null;
  return (await selectConnectionForUpdate(database, userId, clientId)) ?? null;
}

export async function lockOrCreatePartnerConnection(
  database: PartnerDatabase,
  userId: string,
  clientId: string,
): Promise<OAuthConnection | null> {
  if (!(await lockClimber(database, userId))) return null;
  await database.insert(oauthConnections).values({ id: randomUUID(), userId, clientId }).onConflictDoNothing();
  return (await selectConnectionForUpdate(database, userId, clientId)) ?? null;
}

/** Locks the connection and reports whether this authorization code's grant is still current. A missing grant is not. */
export async function lockCurrentGrant(database: PartnerDatabase, owner: FamilyOwner): Promise<boolean> {
  const connection = await lockPartnerConnection(database, owner.userId, owner.clientId);
  if (!connection || connection.revokedAt) return false;
  const [grant] = await database
    .select()
    .from(oauthGrants)
    .where(eq(oauthGrants.authorizationCodeId, owner.authorizationCodeId));
  return grant !== undefined && grant.connectionId === connection.id && grant.generation === connection.generation;
}

/**
 * Takes, before an app's delete cascades, every lock the cascade would
 * otherwise take in Postgres's own order, and takes them in the partner lock
 * order instead (the order at the top of this file): each climber's `users` row
 * FOR SHARE, then the app's open consent screens, then its connections, then
 * provider rows (the cascade itself). A consent answer locks its screen before the connection, so
 * the screens come first here too; Disconnect and the password trigger lock the
 * connection and then skip or wait for nothing this holds. Without this, a
 * cascade holding a connection could wait on a screen that a consent answer
 * holds while that answer waits on the connection.
 *
 * Rows are locked in key order, so two deletions of overlapping state queue
 * instead of crossing. A screen opened after the first pass and already held by
 * a consent answer is the one wait that could still close a cycle: that answer
 * waits on a connection this now holds. The second pass refuses to wait for it
 * (NOWAIT), so the deletion fails fast with 55P03 and its caller retries, rather
 * than Postgres aborting the climber's answer. App deletion and account deletion
 * both call this.
 */
export async function lockAppForDeletion(transaction: PartnerDatabase, clientId: string): Promise<void> {
  const connectionClimbers = transaction
    .select({ userId: oauthConnections.userId })
    .from(oauthConnections)
    .where(eq(oauthConnections.clientId, clientId));
  const screenClimbers = transaction
    .select({ userId: oauthConsentInteractions.userId })
    .from(oauthConsentInteractions)
    .where(eq(oauthConsentInteractions.clientId, clientId));
  await transaction
    .select({ id: users.id })
    .from(users)
    .where(or(inArray(users.id, connectionClimbers), inArray(users.id, screenClimbers)))
    .orderBy(asc(users.id))
    .for('share');
  await transaction
    .select({ digest: oauthConsentInteractions.digest })
    .from(oauthConsentInteractions)
    .where(eq(oauthConsentInteractions.clientId, clientId))
    .orderBy(asc(oauthConsentInteractions.digest))
    .for('update');
  await transaction
    .select({ id: oauthConnections.id })
    .from(oauthConnections)
    .where(eq(oauthConnections.clientId, clientId))
    .orderBy(asc(oauthConnections.id))
    .for('update');
  await transaction
    .select({ digest: oauthConsentInteractions.digest })
    .from(oauthConsentInteractions)
    .where(eq(oauthConsentInteractions.clientId, clientId))
    .for('update', { noWait: true });
}

/**
 * The same locks for every app an account registered, in client id order, for
 * account deletion: the `users` delete cascades into each app exactly as an
 * app delete does. Call it with the account's own `users` row already locked
 * FOR UPDATE (account deletion's first lock), and before the delete.
 *
 * A lock it cannot take (the NOWAIT pass over a consent screen a climber's
 * answer holds) is thrown as `PARTNER_APP_LOCK_BUSY`, a code of its own, so the
 * caller can retry exactly this refusal without retrying every 55P03 its own
 * lock timeouts raise.
 */
export const PARTNER_APP_LOCK_BUSY = 'partner_app_lock_busy';

export async function lockOwnedAppsForDeletion(database: PartnerDatabase, ownerUserId: string): Promise<void> {
  const apps = await database
    .select({ clientId: oauthClient.clientId })
    .from(oauthClient)
    .where(eq(oauthClient.userId, ownerUserId))
    .orderBy(asc(oauthClient.clientId));
  for (const { clientId } of apps) {
    try {
      await lockAppForDeletion(database, clientId);
    } catch (error) {
      if (getPostgresErrorCode(error) !== '55P03') throw error;
      throw Object.assign(new Error("A consent answer holds one of the account's partner apps.", { cause: error }), {
        code: PARTNER_APP_LOCK_BUSY,
      });
    }
  }
}
