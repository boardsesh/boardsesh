import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { oauthConnections, oauthGrants, users } from '@boardsesh/db/schema/auth';
import type { FamilyOwner } from './family-guard';
import type { PartnerDatabase } from './tables';

type OAuthConnection = typeof oauthConnections.$inferSelect;

/**
 * Lock order, always: the climber's `users` row FOR KEY SHARE, then the
 * connection row FOR UPDATE, then provider rows. KEY SHARE does not block
 * ordinary user updates, but it does block the FOR UPDATE that password
 * resets and account deletion take, so they wait for issuers in flight.
 */
async function lockClimber(database: PartnerDatabase, userId: string): Promise<boolean> {
  const climbers = await database.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('key share');
  return climbers.length === 1;
}

async function selectConnectionForUpdate(
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
