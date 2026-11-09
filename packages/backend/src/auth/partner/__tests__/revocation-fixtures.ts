import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  oauthAccessToken,
  oauthAppPolicy,
  oauthClient,
  oauthConnections,
  oauthConsent,
  oauthConsentInteractions,
  oauthGrants,
  oauthRefreshAncestors,
  oauthRefreshToken,
  oauthSession,
  oauthSubjects,
  oauthVerification,
  userCredentials,
  users,
} from '@boardsesh/db/schema/auth';
import { db } from '../../../db/client';

export const PASSWORD_HASH = 'fixture-password-hash-before';
const HOUR_MS = 3_600_000;

export interface PartnerRows {
  climberId: string;
  clientId: string;
  connectionId: string;
  authorizationCodeId: string;
  sessionId: string;
  refreshTokenId: string;
  accessTokenId: string;
  /** A token issued without offline access: no refresh token, so no cascade removes it. */
  standaloneAccessTokenId: string;
  ancestorHash: string;
  interactionDigest: string;
}

export async function createUser(label: string): Promise<string> {
  const userId = `${label}-${randomUUID()}`;
  await db.insert(users).values({ id: userId, email: `${userId}@example.invalid` });
  return userId;
}

/** A developer's app: the policy row a climber's connection hangs off. */
export async function createApp(developerId: string): Promise<string> {
  const clientId = `client-${randomUUID()}`;
  await db
    .insert(oauthClient)
    .values({ id: randomUUID(), clientId, userId: developerId, redirectUris: ['https://app.example.invalid/cb'] });
  await db.insert(oauthAppPolicy).values({ clientId, ownerUserId: developerId });
  return clientId;
}

/** Every per-climber partner row one connected app leaves behind, including a pending code. */
export async function attachPartnerState(climberId: string, clientId: string): Promise<PartnerRows> {
  const now = new Date();
  const later = new Date(now.getTime() + HOUR_MS);
  const sessionId = randomUUID();
  const connectionId = randomUUID();
  const authorizationCodeId = `code-${randomUUID()}`;
  const refreshTokenId = randomUUID();
  const accessTokenId = randomUUID();
  const standaloneAccessTokenId = randomUUID();
  const ancestorHash = `hash-${randomUUID()}`;
  const interactionDigest = `digest-${randomUUID()}`;

  await db.insert(oauthSession).values({
    id: sessionId,
    token: `session-${randomUUID()}`,
    userId: climberId,
    expiresAt: later,
    updatedAt: now,
  });
  await db.insert(oauthConnections).values({ id: connectionId, userId: climberId, clientId, connectedAt: now });
  await db.insert(oauthSubjects).values({ userId: climberId, clientId, subject: `usr_${randomUUID()}` });
  await db.insert(oauthGrants).values({ authorizationCodeId, connectionId, generation: 0 });
  // The pending code: oauth_verification has no user column, so the grant is the only path to it.
  await db.insert(oauthVerification).values({
    id: randomUUID(),
    identifier: authorizationCodeId,
    value: JSON.stringify({ type: 'authorization_code' }),
    expiresAt: later,
  });
  await db.insert(oauthRefreshToken).values({
    id: refreshTokenId,
    token: `refresh-${randomUUID()}`,
    clientId,
    sessionId,
    userId: climberId,
    authorizationCodeId,
    expiresAt: later,
    createdAt: now,
    scopes: ['offline_access'],
  });
  await db.insert(oauthAccessToken).values({
    id: accessTokenId,
    token: `access-${randomUUID()}`,
    clientId,
    sessionId,
    userId: climberId,
    authorizationCodeId,
    refreshId: refreshTokenId,
    expiresAt: later,
    createdAt: now,
    scopes: ['offline_access'],
  });
  await db.insert(oauthAccessToken).values({
    id: standaloneAccessTokenId,
    token: `access-${randomUUID()}`,
    clientId,
    sessionId,
    userId: climberId,
    authorizationCodeId,
    expiresAt: later,
    createdAt: now,
    scopes: ['profile:read'],
  });
  await db.insert(oauthConsent).values({
    id: randomUUID(),
    clientId,
    userId: climberId,
    scopes: ['offline_access'],
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(oauthRefreshAncestors).values({
    tokenHash: ancestorHash,
    clientId,
    userId: climberId,
    authorizationCodeId,
    expiresAt: later,
  });
  await db.insert(oauthConsentInteractions).values({
    digest: interactionDigest,
    userId: climberId,
    authSessionId: randomUUID(),
    clientId,
    connectionGeneration: 0,
    expiresAt: later,
  });

  return {
    climberId,
    clientId,
    connectionId,
    authorizationCodeId,
    sessionId,
    refreshTokenId,
    accessTokenId,
    standaloneAccessTokenId,
    ancestorHash,
    interactionDigest,
  };
}

/** A climber with a password, connected to one app that belongs to a separate developer. */
export async function seedConnectedClimber(label = 'climber'): Promise<PartnerRows> {
  const developerId = await createUser('developer');
  const clientId = await createApp(developerId);
  const climberId = await createUser(label);
  await db.insert(userCredentials).values({ userId: climberId, passwordHash: PASSWORD_HASH });
  return attachPartnerState(climberId, clientId);
}

/** Per-table counts of what `attachPartnerState` created, plus the connection row itself. */
export async function readPartnerState(rows: PartnerRows) {
  const [connection] = await db.select().from(oauthConnections).where(eq(oauthConnections.id, rows.connectionId));
  return {
    connection,
    connections: await db.$count(oauthConnections, eq(oauthConnections.id, rows.connectionId)),
    subjects: await db.$count(
      oauthSubjects,
      and(eq(oauthSubjects.userId, rows.climberId), eq(oauthSubjects.clientId, rows.clientId)),
    ),
    sessions: await db.$count(oauthSession, eq(oauthSession.userId, rows.climberId)),
    grants: await db.$count(oauthGrants, eq(oauthGrants.authorizationCodeId, rows.authorizationCodeId)),
    pendingCodes: await db.$count(oauthVerification, eq(oauthVerification.identifier, rows.authorizationCodeId)),
    refreshTokens: await db.$count(oauthRefreshToken, eq(oauthRefreshToken.id, rows.refreshTokenId)),
    accessTokens: await db.$count(
      oauthAccessToken,
      inArray(oauthAccessToken.id, [rows.accessTokenId, rows.standaloneAccessTokenId]),
    ),
    consents: await db.$count(oauthConsent, eq(oauthConsent.userId, rows.climberId)),
    ancestors: await db.$count(oauthRefreshAncestors, eq(oauthRefreshAncestors.tokenHash, rows.ancestorHash)),
    interactions: await db.$count(
      oauthConsentInteractions,
      eq(oauthConsentInteractions.digest, rows.interactionDigest),
    ),
  };
}

export type PartnerState = Awaited<ReturnType<typeof readPartnerState>>;

export const REVOKED_COUNTS = {
  connections: 1,
  subjects: 1, // The stable public id survives; it is not credential material.
  sessions: 0,
  grants: 0,
  pendingCodes: 0,
  refreshTokens: 0,
  accessTokens: 0,
  consents: 0,
  ancestors: 0,
  interactions: 0,
} as const;

export const INTACT_COUNTS = {
  connections: 1,
  subjects: 1,
  sessions: 1,
  grants: 1,
  pendingCodes: 1,
  refreshTokens: 1,
  accessTokens: 2,
  consents: 1,
  ancestors: 1,
  interactions: 1,
} as const;

/** The counts of a `readPartnerState` result, without the connection row itself. */
export function countsOf(state: PartnerState) {
  const { connection: _connection, ...counts } = state;
  return counts;
}

/**
 * One entry per table partner_revoke_user probes. Each inserts a single row with
 * nothing else beside it, so a test can prove that table alone is enough.
 */
export interface PartnerProbeTable {
  table: string;
  insertOnlyRow(climberId: string, clientId: string): Promise<unknown>;
  liveRows(climberId: string): Promise<number>;
}

const inAnHour = () => new Date(Date.now() + HOUR_MS);

export const PARTNER_PROBE_TABLES: readonly PartnerProbeTable[] = [
  {
    table: 'oauth_connections',
    insertOnlyRow: (userId, clientId) =>
      db.insert(oauthConnections).values({ id: randomUUID(), userId, clientId, connectedAt: new Date() }),
    liveRows: (userId) =>
      db.$count(oauthConnections, and(eq(oauthConnections.userId, userId), isNull(oauthConnections.revokedAt))),
  },
  {
    table: 'oauth_access_token',
    insertOnlyRow: (userId, clientId) =>
      db.insert(oauthAccessToken).values({
        id: randomUUID(),
        token: `access-${randomUUID()}`,
        clientId,
        userId,
        expiresAt: inAnHour(),
        createdAt: new Date(),
        scopes: ['profile:read'],
      }),
    liveRows: (userId) => db.$count(oauthAccessToken, eq(oauthAccessToken.userId, userId)),
  },
  {
    table: 'oauth_refresh_token',
    insertOnlyRow: (userId, clientId) =>
      db.insert(oauthRefreshToken).values({
        id: randomUUID(),
        token: `refresh-${randomUUID()}`,
        clientId,
        userId,
        expiresAt: inAnHour(),
        createdAt: new Date(),
        scopes: ['offline_access'],
      }),
    liveRows: (userId) => db.$count(oauthRefreshToken, eq(oauthRefreshToken.userId, userId)),
  },
  {
    table: 'oauth_consent',
    insertOnlyRow: (userId, clientId) =>
      db.insert(oauthConsent).values({
        id: randomUUID(),
        clientId,
        userId,
        scopes: ['profile:read'],
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    liveRows: (userId) => db.$count(oauthConsent, eq(oauthConsent.userId, userId)),
  },
  {
    table: 'oauth_refresh_ancestors',
    insertOnlyRow: (userId, clientId) =>
      db.insert(oauthRefreshAncestors).values({
        tokenHash: `hash-${randomUUID()}`,
        clientId,
        userId,
        authorizationCodeId: `code-${randomUUID()}`,
        expiresAt: inAnHour(),
      }),
    liveRows: (userId) => db.$count(oauthRefreshAncestors, eq(oauthRefreshAncestors.userId, userId)),
  },
  {
    table: 'oauth_consent_interactions',
    insertOnlyRow: (userId, clientId) =>
      db.insert(oauthConsentInteractions).values({
        digest: `digest-${randomUUID()}`,
        userId,
        authSessionId: randomUUID(),
        clientId,
        connectionGeneration: 0,
        expiresAt: inAnHour(),
      }),
    liveRows: (userId) => db.$count(oauthConsentInteractions, eq(oauthConsentInteractions.userId, userId)),
  },
  {
    table: 'oauth_session',
    insertOnlyRow: (userId) =>
      db.insert(oauthSession).values({
        id: randomUUID(),
        token: `session-${randomUUID()}`,
        userId,
        expiresAt: inAnHour(),
        updatedAt: new Date(),
      }),
    liveRows: (userId) => db.$count(oauthSession, eq(oauthSession.userId, userId)),
  },
];

export async function passwordHashOf(userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ passwordHash: userCredentials.passwordHash })
    .from(userCredentials)
    .where(eq(userCredentials.userId, userId));
  return row?.passwordHash;
}
