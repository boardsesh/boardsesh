import { randomUUID } from 'node:crypto';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getSchema } from 'better-auth/db';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { oauthProvider } from '@better-auth/oauth-provider';
import { eq, getTableColumns, is } from 'drizzle-orm';
import { getTableConfig, PgTable, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  oauthAccessToken,
  oauthAppPolicy,
  oauthClient,
  oauthClientResource,
  oauthConnections,
  oauthConsent,
  oauthConsentInteractions,
  oauthGrants,
  oauthRefreshAncestors,
  oauthRefreshToken,
  oauthResource,
  oauthSession,
  oauthSubjects,
  users,
} from '@boardsesh/db/schema/auth';
import { db } from '../../../db/client';
import { partnerAdapterSchema } from '../tables';

/**
 * Proves the tables in packages/db/src/schema/auth/partner-oauth.ts are the ones
 * pinned Better Auth 1.7.17 and its OAuth Provider plugin read and write, and that
 * deleting a user removes what the partner OAuth plan requires. Field and table
 * names come from the provider itself, so a version bump that changes them fails
 * here. The Better Auth `user`, `session` and `verification` mapping mirrors the
 * partner authority's configuration.
 */
const PARTNER_ADAPTER_SCHEMA = partnerAdapterSchema;

type AdapterModelName = keyof typeof PARTNER_ADAPTER_SCHEMA;

const PARTNER_POLICY_TABLES = [
  oauthAppPolicy,
  oauthConnections,
  oauthSubjects,
  oauthGrants,
  oauthRefreshAncestors,
  oauthConsentInteractions,
] as const;

const PARTNER_TABLES: readonly PgTable[] = [
  ...Object.values(PARTNER_ADAPTER_SCHEMA).filter((table) => table !== users),
  ...PARTNER_POLICY_TABLES,
];

const PARTNER_AUTH_OPTIONS = {
  appName: 'Boardsesh partner OAuth schema test',
  baseURL: 'https://api.boardsesh.test/api/auth',
  secret: 'partner-oauth-schema-test-secret-never-deployed',
  user: { modelName: 'users' },
  session: { modelName: 'oauthSession' },
  verification: { modelName: 'oauthVerification' },
  rateLimit: { enabled: false },
  telemetry: { enabled: false },
  logger: { disabled: true },
  plugins: [
    oauthProvider({
      loginPage: 'https://www.boardsesh.test/oauth/sign-in',
      consentPage: 'https://www.boardsesh.test/oauth/consent',
      disableJwtPlugin: true,
      allowDynamicClientRegistration: false,
      scopes: ['profile:read', 'logbook:read', 'offline_access'],
      resources: [],
    }),
  ],
} satisfies BetterAuthOptions;

const providerModels = getSchema(PARTNER_AUTH_OPTIONS);

const PROVIDER_MODEL_NAMES = Object.keys(providerModels).filter(
  (modelName) => modelName !== 'account' && modelName !== 'users',
);

const EXPECTED_SQL_TYPE: Record<string, string> = {
  string: 'text',
  'string[]': 'text[]',
  boolean: 'boolean',
  number: 'integer',
  date: 'timestamp with time zone',
  json: 'jsonb',
};

function adapterTable(modelName: string): PgTable {
  const table: unknown = PARTNER_ADAPTER_SCHEMA[modelName as AdapterModelName];
  if (!is(table, PgTable)) throw new Error(`${modelName} is not in the partner adapter schema.`);
  return table;
}

function columnsOf(table: PgTable): Record<string, AnyPgColumn> {
  return getTableColumns(table) as Record<string, AnyPgColumn>;
}

function indexedColumnNames(columns: readonly unknown[]): string[] {
  return columns.map((indexedColumn) => {
    if (typeof indexedColumn !== 'object' || indexedColumn === null || !('name' in indexedColumn)) {
      throw new Error('Partner OAuth indexes must be on plain columns.');
    }
    return String(indexedColumn.name);
  });
}

/** Columns a lookup can seek on directly: primary, unique, or the first column of an index. */
function seekableColumnNames(table: PgTable): Set<string> {
  const config = getTableConfig(table);
  const seekable = new Set<string>();
  for (const column of config.columns) if (column.primary || column.isUnique) seekable.add(column.name);
  for (const primaryKey of config.primaryKeys) seekable.add(primaryKey.columns[0].name);
  for (const uniqueConstraint of config.uniqueConstraints) seekable.add(uniqueConstraint.columns[0].name);
  for (const tableIndex of config.indexes) seekable.add(indexedColumnNames(tableIndex.config.columns)[0]);
  return seekable;
}

describe('partner OAuth schema against pinned Better Auth 1.7.17', () => {
  it('leaves Better Auth account as the only missing model in the pinned schema check', async () => {
    const authority = betterAuth({
      ...PARTNER_AUTH_OPTIONS,
      // Never connects: the schema check reads the Drizzle objects, not the database.
      database: drizzleAdapter(drizzle.mock(), { provider: 'pg', schema: PARTNER_ADAPTER_SCHEMA }),
    });
    const context = await authority.$context;
    expect(context.checkSchema).toBeDefined();
    await expect(context.checkSchema?.()).rejects.toMatchObject({
      findings: [{ kind: 'missing-table', table: 'account' }],
    });
  });

  it('accounts for every model the pinned provider declares', () => {
    expect(PROVIDER_MODEL_NAMES.sort()).toEqual(
      Object.keys(PARTNER_ADAPTER_SCHEMA)
        .filter((modelName) => modelName !== 'users')
        .sort(),
    );
  });

  it.each(PROVIDER_MODEL_NAMES)('%s has the columns, types, nullability and constraints the provider needs', (name) => {
    const model = providerModels[name];
    const table = adapterTable(name);
    const columns = columnsOf(table);
    const foreignKeys = getTableConfig(table).foreignKeys.map((foreignKey) => ({
      reference: foreignKey.reference(),
      onDelete: foreignKey.onDelete,
    }));

    for (const [fieldName, field] of Object.entries(model.fields)) {
      const column = columns[fieldName];
      expect(column, `${name}.${fieldName} is missing`).toBeDefined();
      expect(column.getSQLType(), `${name}.${fieldName} type`).toBe(EXPECTED_SQL_TYPE[String(field.type)]);
      expect(column.notNull, `${name}.${fieldName} nullability`).toBe(field.required !== false);
      expect(column.isUnique, `${name}.${fieldName} uniqueness`).toBe(Boolean(field.unique));

      if (field.references) {
        const targetColumn = columnsOf(adapterTable(field.references.model))[field.references.field];
        const matching = foreignKeys.filter(
          ({ reference }) => reference.columns.length === 1 && reference.columns[0] === column,
        );
        expect(matching, `${name}.${fieldName} foreign key`).toHaveLength(1);
        expect(matching[0].reference.foreignColumns).toEqual([targetColumn]);
        expect(matching[0].onDelete, `${name}.${fieldName} delete rule`).toBe(field.references.onDelete ?? 'cascade');
      }

      if (field.index) {
        expect(seekableColumnNames(table).has(column.name), `${name}.${fieldName} index`).toBe(true);
      }
    }

    for (const providerIndex of model.indexes ?? []) {
      const expectedColumnNames = providerIndex.columns.map((fieldName) => columns[fieldName].name);
      const found = getTableConfig(table).indexes.find(
        (tableIndex) =>
          JSON.stringify(indexedColumnNames(tableIndex.config.columns)) === JSON.stringify(expectedColumnNames) &&
          Boolean(tableIndex.config.unique) === Boolean(providerIndex.unique),
      );
      expect(found, `${name} index on ${expectedColumnNames.join(', ')}`).toBeDefined();
    }
  });

  it('maps the provider user model onto users with only the documented differences', () => {
    const columns = columnsOf(users);
    const differences: string[] = [];
    for (const [fieldName, field] of Object.entries(providerModels.users.fields)) {
      const column = columns[fieldName];
      expect(column, `users.${fieldName} is missing`).toBeDefined();
      if (column.notNull !== (field.required !== false)) differences.push(`${fieldName}: nullability`);
      if (column.isUnique !== Boolean(field.unique)) differences.push(`${fieldName}: uniqueness`);
      if (field.type === 'boolean' && column.dataType !== 'boolean') differences.push(`${fieldName}: type`);
    }
    // Harmless while the provider only reads users by id. Writes and userinfo stay off.
    expect(differences.sort()).toEqual([
      'email: uniqueness',
      'emailVerified: nullability',
      'emailVerified: type',
      'name: nullability',
    ]);
  });

  it('gives every foreign key on a partner table a usable index for its cascade', () => {
    for (const table of PARTNER_TABLES) {
      const seekable = seekableColumnNames(table);
      const config = getTableConfig(table);
      for (const foreignKey of config.foreignKeys) {
        for (const column of foreignKey.reference().columns) {
          expect(seekable.has(column.name), `${config.name}.${column.name} has no index`).toBe(true);
        }
      }
    }
  });

  it('points every user reference at users.id with ON DELETE CASCADE', () => {
    const userReferences = PARTNER_TABLES.flatMap((table) => {
      const config = getTableConfig(table);
      return config.foreignKeys.flatMap((foreignKey) => {
        const reference = foreignKey.reference();
        if (getTableConfig(reference.foreignTable).name !== 'users') return [];
        expect(reference.foreignColumns).toEqual([users.id]);
        expect(foreignKey.onDelete, `${config.name} delete rule`).toBe('cascade');
        return [`${config.name}.${reference.columns[0].name}`];
      });
    });
    expect(userReferences.sort()).toEqual([
      'oauth_access_token.user_id',
      'oauth_app_policy.owner_user_id',
      'oauth_client.user_id',
      'oauth_connections.user_id',
      'oauth_consent.user_id',
      'oauth_consent_interactions.user_id',
      'oauth_refresh_ancestors.user_id',
      'oauth_refresh_token.user_id',
      'oauth_session.user_id',
      'oauth_subjects.user_id',
    ]);
  });

  describe('through the pinned Drizzle adapter on the migrated tables', () => {
    function createRealDatabaseAuthority() {
      return betterAuth({
        ...PARTNER_AUTH_OPTIONS,
        // The partner authority has to do the same: `account` is deliberately absent.
        advanced: { database: { validateSchema: false } },
        database: drizzleAdapter(db, { provider: 'pg', schema: PARTNER_ADAPTER_SCHEMA }),
      });
    }
    let context: Awaited<ReturnType<typeof createRealDatabaseAuthority>['$context']>;

    beforeAll(async () => {
      context = await createRealDatabaseAuthority().$context;
    });

    it('stores and reads back arrays, JSON and dates on oauth_client', async () => {
      const clientId = `client-${randomUUID()}`;
      const registeredAt = new Date('2026-11-09T10:15:30.123Z');
      await context.adapter.create({
        model: 'oauthClient',
        data: {
          clientId,
          redirectUris: ['https://app.example.invalid/callback'],
          scopes: ['profile:read', 'offline_access'],
          contacts: ['dev@example.invalid'],
          metadata: { reviewed: false },
          createdAt: registeredAt,
          updatedAt: registeredAt,
        },
      });
      const found = await context.adapter.findOne<Record<string, unknown>>({
        model: 'oauthClient',
        where: [{ field: 'clientId', value: clientId }],
      });
      expect(found?.redirectUris).toEqual(['https://app.example.invalid/callback']);
      expect(found?.scopes).toEqual(['profile:read', 'offline_access']);
      expect(found?.contacts).toEqual(['dev@example.invalid']);
      expect(found?.metadata).toEqual({ reviewed: false });
      expect(found?.createdAt).toEqual(registeredAt);
    });

    it('issues and consumes a code row in oauth_verification', async () => {
      const identifier = `code-${randomUUID()}`;
      const expiresAt = new Date(Date.now() + 60_000);
      await context.internalAdapter.createVerificationValue({
        identifier,
        value: JSON.stringify({ type: 'authorization_code' }),
        expiresAt,
      });
      const consumed = await context.internalAdapter.consumeVerificationValue(identifier);
      expect(consumed?.value).toBe(JSON.stringify({ type: 'authorization_code' }));
      expect(consumed?.expiresAt.getTime()).toBe(expiresAt.getTime());
      expect(await context.internalAdapter.consumeVerificationValue(identifier)).toBeNull();
    });

    it('creates an oauth_session row for an existing user and finds that user by id', async () => {
      const userId = randomUUID();
      await db.insert(users).values({ id: userId, email: `${userId}@example.invalid` });
      const session = await context.internalAdapter.createSession(userId);
      expect(session.userId).toBe(userId);
      const [stored] = await db.select().from(oauthSession).where(eq(oauthSession.id, session.id));
      expect(stored.token).toBe(session.token);
      expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect((await context.internalAdapter.findUserById(userId))?.email).toBe(`${userId}@example.invalid`);
    });
  });
});

describe('deleting a user', () => {
  interface ClimberRows {
    climberId: string;
    connectionId: string;
    authorizationCodeId: string;
    refreshTokenId: string;
    accessTokenId: string;
    ancestorHash: string;
    interactionDigest: string;
  }

  async function createUser(label: string): Promise<string> {
    const userId = `${label}-${randomUUID()}`;
    await db.insert(users).values({ id: userId, email: `${userId}@example.invalid` });
    return userId;
  }

  async function createApp(developerId: string): Promise<{ clientId: string; resourceIdentifier: string }> {
    const clientId = `client-${randomUUID()}`;
    const resourceIdentifier = `https://api.boardsesh.test/${randomUUID()}`;
    await db
      .insert(oauthClient)
      .values({ id: randomUUID(), clientId, userId: developerId, redirectUris: ['https://app.example.invalid/cb'] });
    await db.insert(oauthAppPolicy).values({ clientId, ownerUserId: developerId });
    await db.insert(oauthResource).values({ id: randomUUID(), identifier: resourceIdentifier, name: 'Partner API' });
    await db
      .insert(oauthClientResource)
      .values({ id: randomUUID(), clientId, resourceId: resourceIdentifier, createdAt: new Date() });
    return { clientId, resourceIdentifier };
  }

  /** One climber connected to one app, with a row in every per-climber partner table. */
  async function connectClimber(clientId: string, climberId: string): Promise<ClimberRows> {
    const now = new Date();
    const later = new Date(now.getTime() + 3_600_000);
    const sessionId = randomUUID();
    const connectionId = randomUUID();
    const authorizationCodeId = `code-${randomUUID()}`;
    const refreshTokenId = randomUUID();
    const accessTokenId = randomUUID();
    const ancestorHash = `hash-${randomUUID()}`;
    const interactionDigest = `digest-${randomUUID()}`;

    await db.insert(oauthSession).values({
      id: sessionId,
      token: `session-token-${randomUUID()}`,
      userId: climberId,
      expiresAt: later,
      updatedAt: now,
    });
    await db.insert(oauthConnections).values({ id: connectionId, userId: climberId, clientId, connectedAt: now });
    await db.insert(oauthSubjects).values({ userId: climberId, clientId, subject: `usr_${randomUUID()}` });
    await db.insert(oauthGrants).values({ authorizationCodeId, connectionId, generation: 0 });
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
      connectionId,
      authorizationCodeId,
      refreshTokenId,
      accessTokenId,
      ancestorHash,
      interactionDigest,
    };
  }

  /** How many rows of each per-climber table still belong to this climber's fixture. */
  async function rowsRemaining(rows: ClimberRows) {
    const remaining = {
      sessions: await db.$count(oauthSession, eq(oauthSession.userId, rows.climberId)),
      connections: await db.$count(oauthConnections, eq(oauthConnections.id, rows.connectionId)),
      subjects: await db.$count(oauthSubjects, eq(oauthSubjects.userId, rows.climberId)),
      grants: await db.$count(oauthGrants, eq(oauthGrants.authorizationCodeId, rows.authorizationCodeId)),
      refreshTokens: await db.$count(oauthRefreshToken, eq(oauthRefreshToken.id, rows.refreshTokenId)),
      accessTokens: await db.$count(oauthAccessToken, eq(oauthAccessToken.id, rows.accessTokenId)),
      consents: await db.$count(oauthConsent, eq(oauthConsent.userId, rows.climberId)),
      ancestors: await db.$count(oauthRefreshAncestors, eq(oauthRefreshAncestors.tokenHash, rows.ancestorHash)),
      interactions: await db.$count(
        oauthConsentInteractions,
        eq(oauthConsentInteractions.digest, rows.interactionDigest),
      ),
    };
    return remaining;
  }

  const NONE_LEFT = {
    sessions: 0,
    connections: 0,
    subjects: 0,
    grants: 0,
    refreshTokens: 0,
    accessTokens: 0,
    consents: 0,
    ancestors: 0,
    interactions: 0,
  };

  const ALL_LEFT = {
    sessions: 1,
    connections: 1,
    subjects: 1,
    grants: 1,
    refreshTokens: 1,
    accessTokens: 1,
    consents: 1,
    ancestors: 1,
    interactions: 1,
  };

  it('removes everything a climber owns and leaves other climbers and the developer app', async () => {
    const developerId = await createUser('developer');
    const { clientId } = await createApp(developerId);
    const deletedClimber = await connectClimber(clientId, await createUser('deleted-climber'));
    const otherClimber = await connectClimber(clientId, await createUser('other-climber'));

    await db.delete(users).where(eq(users.id, deletedClimber.climberId));

    expect(await rowsRemaining(deletedClimber)).toEqual(NONE_LEFT);
    expect(await rowsRemaining(otherClimber)).toEqual(ALL_LEFT);
    expect(await db.$count(oauthClient, eq(oauthClient.clientId, clientId))).toBe(1);
    expect(await db.$count(oauthAppPolicy, eq(oauthAppPolicy.clientId, clientId))).toBe(1);
  });

  it('removes the app, its policy and every connection and token when the developer is deleted', async () => {
    const developerId = await createUser('developer');
    const { clientId, resourceIdentifier } = await createApp(developerId);
    const firstClimber = await connectClimber(clientId, await createUser('first-climber'));
    const secondClimber = await connectClimber(clientId, await createUser('second-climber'));

    await db.delete(users).where(eq(users.id, developerId));

    expect(await db.$count(oauthClient, eq(oauthClient.clientId, clientId))).toBe(0);
    expect(await db.$count(oauthAppPolicy, eq(oauthAppPolicy.clientId, clientId))).toBe(0);
    expect(await db.$count(oauthClientResource, eq(oauthClientResource.clientId, clientId))).toBe(0);
    // The climbers keep their accounts and the provider keeps the shared resource.
    expect(await db.$count(users, eq(users.id, firstClimber.climberId))).toBe(1);
    expect(await db.$count(oauthResource, eq(oauthResource.identifier, resourceIdentifier))).toBe(1);
    for (const rows of [firstClimber, secondClimber]) {
      // Their sessions are not app-scoped, so they survive the app's deletion.
      expect(await rowsRemaining(rows)).toEqual({ ...NONE_LEFT, sessions: 1 });
    }
  });

  it('drops only the session link when an oauth_session row goes away', async () => {
    const { clientId } = await createApp(await createUser('developer'));
    const rows = await connectClimber(clientId, await createUser('climber'));

    await db.delete(oauthSession).where(eq(oauthSession.userId, rows.climberId));

    const [refreshToken] = await db
      .select()
      .from(oauthRefreshToken)
      .where(eq(oauthRefreshToken.id, rows.refreshTokenId));
    const [accessToken] = await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.id, rows.accessTokenId));
    expect(refreshToken.sessionId).toBeNull();
    expect(accessToken.sessionId).toBeNull();
  });
});
