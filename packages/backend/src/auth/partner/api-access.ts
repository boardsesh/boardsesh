import { randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { oauthAccessToken, oauthConnections, oauthSubjects, userProfiles, users } from '@boardsesh/db/schema/auth';
import { logger } from '../../utils/logger';
import { getPostgresErrorCode } from '../../utils/postgres-errors';
import { findPartnerApiPrincipal, type PartnerApiPrincipal, type PartnerBearerResult } from './bearer';
import { endPartnerConnection } from './connection';
import { lockPartnerConnection } from './locks';
import type { PartnerDatabase } from './tables';
import { isPartnerDatabaseBusy, runInPartnerTransaction } from './transaction';

/** foreign_key_violation */
const FOREIGN_KEY_VIOLATION = '23503';

/** What `/v1/me` reads. The handler shapes it into the public contract. */
export interface PartnerClimberRecord {
  /** The app's own id for this climber (`usr_…`), never `users.id`. */
  subject: string;
  /** Present only when the token carries `profile:read`. */
  profile?: { displayName: string | null; avatarUrl: string | null };
}

export type PartnerApiDisconnectOutcome = 'disconnected' | 'already_disconnected' | 'token_invalid';

/**
 * How fine Connected apps' "last used" is. A connection's `last_used_at` is
 * written at most once per this interval, so a busy app costs one small write
 * an hour, not one per request.
 */
export const PARTNER_LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

/** True when the stored last use is missing or at least an hour old, so this request should write it. */
export function partnerLastUseIsStale(lastUsedAt: Date | null, now: Date): boolean {
  return lastUsedAt === null || now.getTime() - lastUsedAt.getTime() >= PARTNER_LAST_USED_RESOLUTION_MS;
}

export interface PartnerApiAccess {
  /** Hashes the token the way the provider stores it, then checks it. */
  authenticate(accessToken: string): Promise<PartnerBearerResult>;
  /** Null when the climber is gone. */
  readClimber(principal: PartnerApiPrincipal): Promise<PartnerClimberRecord | null>;
  disconnect(principal: PartnerApiPrincipal): Promise<PartnerApiDisconnectOutcome>;
  /**
   * Stamps the connection's `last_used_at` after a token passed, at most once an
   * hour. Never waits for a lock and never throws: true only when it wrote.
   */
  recordUse(principal: PartnerApiPrincipal): Promise<boolean>;
  /** A lock wait or statement timeout: answer 503 and let the app retry. */
  isDatabaseBusy(error: unknown): boolean;
}

const SUBJECT_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** 22 base-62 characters: 130 random bits. */
const SUBJECT_LENGTH = 22;
/** The largest multiple of 62 below 256, so every character is equally likely. */
const UNBIASED_BYTE_LIMIT = 248;
const MINT_ATTEMPTS = 3;

/** `usr_` and random characters only, so no hyphen: the contract rejects a UUID behind the prefix. */
export function mintPartnerSubject(): string {
  let characters = '';
  while (characters.length < SUBJECT_LENGTH) {
    for (const byte of randomBytes(SUBJECT_LENGTH * 2)) {
      if (byte >= UNBIASED_BYTE_LIMIT) continue;
      characters += SUBJECT_ALPHABET[byte % SUBJECT_ALPHABET.length];
      if (characters.length === SUBJECT_LENGTH) break;
    }
  }
  return `usr_${characters}`;
}

async function findSubject(transaction: PartnerDatabase, userId: string, clientId: string) {
  const [existing] = await transaction
    .select({ subject: oauthSubjects.subject })
    .from(oauthSubjects)
    .where(and(eq(oauthSubjects.userId, userId), eq(oauthSubjects.clientId, clientId)));
  return existing?.subject;
}

/**
 * The climber's id for this app, minted the first time the app asks. It is
 * never deleted on Disconnect, so a reconnect reads the same one. Two first
 * requests racing each other both end with the row the first commit wrote.
 */
export async function ensurePartnerSubject(
  transaction: PartnerDatabase,
  userId: string,
  clientId: string,
): Promise<string> {
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
    const existing = await findSubject(transaction, userId, clientId);
    if (existing) return existing;
    await transaction
      .insert(oauthSubjects)
      .values({ userId, clientId, subject: mintPartnerSubject() })
      .onConflictDoNothing();
  }
  const minted = await findSubject(transaction, userId, clientId);
  if (!minted) throw new Error('Could not mint a partner subject.');
  return minted;
}

/** Display name and avatar fall back to the sign-in provider's, as everywhere else in Boardsesh. */
async function readProfile(transaction: PartnerDatabase, userId: string) {
  const [row] = await transaction
    .select({
      name: users.name,
      image: users.image,
      displayName: userProfiles.displayName,
      avatarUrl: userProfiles.avatarUrl,
    })
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(eq(users.id, userId));
  if (!row) return null;
  return { displayName: row.displayName || row.name || null, avatarUrl: row.avatarUrl || row.image || null };
}

export function createPartnerApiAccess({
  database,
  resource,
  hashAccessToken,
}: {
  database: PartnerDatabase;
  resource: string;
  hashAccessToken: (accessToken: string) => Promise<string>;
}): PartnerApiAccess {
  return {
    async authenticate(accessToken) {
      return findPartnerApiPrincipal(database, { accessTokenHash: await hashAccessToken(accessToken), resource });
    },

    async readClimber(principal) {
      try {
        return await runInPartnerTransaction(database, async (transaction) => {
          // Read even without profile:read, so a climber deleted since the token
          // check gets a 401 rather than a subject minted for nobody.
          const profile = await readProfile(transaction, principal.userId);
          if (!profile) return null;
          const subject = await ensurePartnerSubject(transaction, principal.userId, principal.clientId);
          return principal.scopes.includes('profile:read') ? { subject, profile } : { subject };
        });
      } catch (error) {
        // A deletion of the climber or the app that commits between the profile
        // read and the subject insert fails the insert's foreign key. The token
        // went with it, so this is the same answer as a token that is gone.
        if (getPostgresErrorCode(error) === FOREIGN_KEY_VIOLATION) return null;
        throw error;
      }
    },

    /**
     * `DELETE /v1/connection`. Takes the climber's row FOR SHARE, then the
     * connection FOR UPDATE, the order every partner writer uses, and checks
     * the token again under those locks: a token that stopped working after
     * the unlocked check cannot end a connection the climber has since made
     * again. An already-ended connection is the state the app asked for.
     */
    disconnect(principal) {
      return runInPartnerTransaction(database, async (transaction) => {
        const connection = await lockPartnerConnection(transaction, principal.userId, principal.clientId);
        if (!connection || connection.id !== principal.connectionId) return 'token_invalid';
        if (connection.revokedAt) return 'already_disconnected';
        if (connection.generation !== principal.connectionGeneration) return 'token_invalid';
        const [stillIssued] = await transaction
          .select({ id: oauthAccessToken.id })
          .from(oauthAccessToken)
          .where(
            and(
              eq(oauthAccessToken.token, principal.accessTokenHash),
              isNull(oauthAccessToken.revoked),
              gt(oauthAccessToken.expiresAt, new Date()),
            ),
          );
        if (!stillIssued) return 'token_invalid';
        await endPartnerConnection(transaction, connection, 'app_disconnect');
        return 'disconnected';
      });
    },

    async recordUse(principal) {
      if (!partnerLastUseIsStale(principal.connectionLastUsedAt, new Date())) return false;
      try {
        return await touchPartnerConnectionLastUsed(database, principal);
      } catch (error) {
        // A missed stamp only makes "last used" an hour staler; the request goes on.
        logger.warn('Partner connection last use not recorded', {
          clientId: principal.clientId,
          errorName: error instanceof Error ? error.name : 'unknown',
          postgresCode: getPostgresErrorCode(error),
        });
        return false;
      }
    },

    isDatabaseBusy: isPartnerDatabaseBusy,
  };
}

/**
 * How long the stamp may wait for the table lock its UPDATE takes. SKIP LOCKED
 * covers row locks only; a migration holding `oauth_connections` would
 * otherwise hold every stale request for the partner 2 s lock timeout.
 */
const LAST_USED_LOCK_TIMEOUT = '50ms';

/**
 * One UPDATE that names its row through `FOR NO KEY UPDATE SKIP LOCKED`, so it
 * never waits for a row: a connection a Disconnect, a refresh, a consent answer
 * or the password trigger holds is skipped, and a later request tries again. A
 * table lock (a migration) is waited for at most 50 ms, then the stamp gives up. The hour is checked again in SQL, so of two requests racing past the
 * unlocked read only the first writes; the second finds the row locked or
 * already fresh. It holds the row for that one statement only, and it never
 * touches `users`, so it cannot join a partner lock cycle. A connection ended or
 * reconnected since the token check is left alone.
 */
export async function touchPartnerConnectionLastUsed(
  database: PartnerDatabase,
  { connectionId, connectionGeneration }: Pick<PartnerApiPrincipal, 'connectionId' | 'connectionGeneration'>,
): Promise<boolean> {
  return runInPartnerTransaction(database, async (transaction) => {
    await transaction.execute(sql`select set_config('lock_timeout', ${LAST_USED_LOCK_TIMEOUT}, true)`);
    const stamped = await transaction
      .update(oauthConnections)
      .set({ lastUsedAt: sql`now()` })
      .where(
        inArray(
          oauthConnections.id,
          transaction
            .select({ id: oauthConnections.id })
            .from(oauthConnections)
            .where(
              and(
                eq(oauthConnections.id, connectionId),
                eq(oauthConnections.generation, connectionGeneration),
                isNull(oauthConnections.revokedAt),
                or(
                  isNull(oauthConnections.lastUsedAt),
                  lt(
                    oauthConnections.lastUsedAt,
                    sql`now() - make_interval(secs => ${PARTNER_LAST_USED_RESOLUTION_MS / 1000})`,
                  ),
                ),
              ),
            )
            .for('no key update', { skipLocked: true }),
        ),
      )
      .returning({ id: oauthConnections.id });
    return stamped.length > 0;
  });
}
