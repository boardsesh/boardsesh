import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { createAuthMiddleware } from 'better-auth/api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  oauthAccessToken,
  oauthConnections,
  oauthConsent,
  oauthGrants,
  oauthRefreshAncestors,
  oauthRefreshToken,
  oauthVerification,
  users,
} from '@boardsesh/db/schema/auth';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';
import { disconnectPartnerConnection } from '../connection';
import { lockCurrentGrant } from '../locks';
import { currentPartnerTransaction, handlePartnerRequest, runInPartnerTransaction } from '../transaction';
import {
  clientCredentials,
  createPartnerTestEnvironment,
  postForm,
  READ_ONLY_PROOF_APPLICATION_NAME,
  TEST_OAUTH_OPTIONS,
  TEST_RESOURCE,
  TEST_SESSION_HEADER,
  type PartnerTestEnvironment,
  type TestClient,
} from './partner-fixture';

const TEST_DEADLINE_MS = 20_000;
const TEST_OAUTH_ISSUER = 'https://api.boardsesh.test/api/auth';

/** Runs `hold` in a transaction on its own connection and resolves once the lock is held. */
async function holdLock(acquire: (transaction: typeof db) => Promise<unknown>): Promise<() => Promise<void>> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settled = false;
  let lockHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    lockHeld = resolve;
  });
  const finished = db
    .transaction(async (transaction) => {
      await acquire(transaction as unknown as typeof db);
      lockHeld();
      await released;
    })
    .finally(() => {
      settled = true;
    });
  await held;
  return async () => {
    if (settled) return;
    release();
    await finished;
  };
}

/** Waits until `count` partner requests are blocked on a database lock. */
async function waitForBlockedRequests(count: number, deadlineMs = 5_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const blocked = await db.execute(
      sql`select pid from pg_stat_activity where wait_event_type = 'Lock' and application_name = ${READ_ONLY_PROOF_APPLICATION_NAME}`,
    );
    if (blocked.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Expected ${count} blocked partner requests within ${deadlineMs} ms.`);
}

/** Better Auth stores tokens as an unpadded base64url SHA-256. */
async function hashForTest(token: string): Promise<string> {
  return createHash('sha256').update(token).digest('base64url');
}

async function connectionRow(client: TestClient) {
  const [connection] = await db.select().from(oauthConnections).where(eq(oauthConnections.clientId, client.clientId));
  return connection;
}

describe('partner fence', () => {
  let environment: PartnerTestEnvironment;

  beforeAll(async () => {
    environment = await createPartnerTestEnvironment();
  });

  afterAll(async () => {
    await environment?.close();
  });

  const lockConnectionFor = (client: TestClient) =>
    holdLock((transaction) =>
      transaction
        .select({ id: oauthConnections.id })
        .from(oauthConnections)
        .where(eq(oauthConnections.clientId, client.clientId))
        .for('update'),
    );

  it('binds a code to the connection generation, and marks the connection connected once the code is redeemed', async () => {
    const client = await environment.createClient();
    const authorization = await environment.authorize(client);
    expect(authorization.response.status).toBe(302);
    const connection = await connectionRow(client);
    expect(connection.userId).toBe(client.owner.userId);
    expect(connection.generation).toBe(0);
    // An issued code is not a connection yet: it counts towards no cap until redeemed.
    expect(connection.connectedAt).toBeNull();
    const grants = await db.select().from(oauthGrants).where(eq(oauthGrants.connectionId, connection.id));
    expect(grants).toHaveLength(1);
    expect(grants[0].generation).toBe(0);
    // The grant key is the hash the code row is stored under.
    const [code] = await db
      .select()
      .from(oauthVerification)
      .where(eq(oauthVerification.identifier, grants[0].authorizationCodeId));
    expect(code).toBeDefined();
    expect((await environment.exchange(client, authorization)).response.status).toBe(200);
    expect((await connectionRow(client)).connectedAt).not.toBeNull();
  });

  it('fails a code closed when its grant row is missing, without consuming the code', async () => {
    const client = await environment.createClient();
    const authorization = await environment.authorize(client);
    const connection = await connectionRow(client);
    const [grant] = await db.select().from(oauthGrants).where(eq(oauthGrants.connectionId, connection.id));
    await db.delete(oauthGrants).where(eq(oauthGrants.authorizationCodeId, grant.authorizationCodeId));
    const redeemed = await environment.exchange(client, authorization);
    expect(redeemed.response.status).toBe(400);
    expect(redeemed.body.error).toBe('invalid_grant');
    expect(
      await db.select().from(oauthVerification).where(eq(oauthVerification.identifier, grant.authorizationCodeId)),
    ).toHaveLength(1);
    expect(await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.clientId, client.clientId))).toHaveLength(
      0,
    );
  });

  it('fails refresh closed when the grant row is missing', async () => {
    const client = await environment.createClient();
    const issued = await environment.issueTokens(client);
    const [grant] = await db
      .select()
      .from(oauthGrants)
      .where(eq(oauthGrants.connectionId, (await connectionRow(client)).id));
    await db.delete(oauthGrants).where(eq(oauthGrants.authorizationCodeId, grant.authorizationCodeId));
    expect((await environment.refresh(client, issued.refresh_token!)).body.error).toBe('invalid_grant');
  });

  it('refuses a code and a refresh token after the generation moves', async () => {
    const client = await environment.createClient();
    const issued = await environment.issueTokens(client);
    const pending = await environment.authorize(client);
    await db
      .update(oauthConnections)
      .set({ generation: sql`${oauthConnections.generation} + 1` })
      .where(eq(oauthConnections.clientId, client.clientId));
    expect((await environment.exchange(client, pending)).body.error).toBe('invalid_grant');
    expect((await environment.refresh(client, issued.refresh_token!)).body.error).toBe('invalid_grant');
  });

  it('refuses a code and a refresh token once the connection is revoked', async () => {
    const client = await environment.createClient();
    const issued = await environment.issueTokens(client);
    const pending = await environment.authorize(client);
    await db
      .update(oauthConnections)
      .set({ revokedAt: new Date() })
      .where(eq(oauthConnections.clientId, client.clientId));
    expect((await environment.exchange(client, pending)).body.error).toBe('invalid_grant');
    expect((await environment.refresh(client, issued.refresh_token!)).body.error).toBe('invalid_grant');
  });

  describe('Disconnect', () => {
    it('ends tokens, consent, ancestry and pending codes for one connection only', async () => {
      // A client that shows consent, so a remembered consent row really exists.
      const client = await environment.createClient({ skipConsent: false });
      const unrelated = await environment.createClient({ owner: client.owner });
      const atConsent = await environment.authorize(client);
      const accepted = await environment.consent(client.owner, {
        accept: true,
        oauth_query: new URL(atConsent.location!).searchParams.toString(),
      });
      const exchanged = await environment.exchange(client, {
        location: accepted.body.url!,
        verifier: atConsent.verifier,
      });
      expect(exchanged.response.status).toBe(200);
      const issued = { ...exchanged.body, access_token: exchanged.body.access_token! };
      const rotated = await environment.refresh(client, issued.refresh_token!);
      expect(rotated.response.status).toBe(200);
      const pending = await environment.authorize(client);
      const pendingCode = new URL(pending.location!).searchParams.get('code')!;
      const pendingCodeHash = await hashForTest(pendingCode);
      const unrelatedTokens = await environment.issueTokens(unrelated);
      expect(await db.select().from(oauthConsent).where(eq(oauthConsent.clientId, client.clientId))).toHaveLength(1);
      expect(
        await db.select().from(oauthVerification).where(eq(oauthVerification.identifier, pendingCodeHash)),
      ).toHaveLength(1);

      expect(
        await disconnectPartnerConnection(environment.database, {
          userId: client.owner.userId,
          clientId: client.clientId,
          reason: 'climber_disconnect',
        }),
      ).toBe(true);

      expect((await environment.exchange(client, pending)).body.error).toBe('invalid_grant');
      expect((await environment.introspect(client, issued.access_token)).body.active).toBe(false);
      expect((await environment.introspect(client, rotated.body.access_token!)).body.active).toBe(false);
      expect((await environment.refresh(client, rotated.body.refresh_token!)).body.error).toBe('invalid_grant');
      const connection = await connectionRow(client);
      expect(connection.generation).toBe(1);
      expect(connection.revokedAt).not.toBeNull();
      expect(connection.revocationReason).toBe('climber_disconnect');
      expect(await db.select().from(oauthGrants).where(eq(oauthGrants.connectionId, connection.id))).toHaveLength(0);
      expect(
        await db.select().from(oauthRefreshAncestors).where(eq(oauthRefreshAncestors.clientId, client.clientId)),
      ).toHaveLength(0);
      expect(await db.select().from(oauthConsent).where(eq(oauthConsent.clientId, client.clientId))).toHaveLength(0);
      expect(
        await db.select().from(oauthVerification).where(eq(oauthVerification.identifier, pendingCodeHash)),
      ).toHaveLength(0);

      expect((await environment.introspect(unrelated, unrelatedTokens.access_token)).body.active).toBe(true);
      expect((await environment.refresh(unrelated, unrelatedTokens.refresh_token!)).response.status).toBe(200);
    });

    it('is a no-op when nothing is connected, and returns false the second time', async () => {
      const client = await environment.createClient();
      const stranger = await environment.createClimber();
      const none = await disconnectPartnerConnection(environment.database, {
        userId: stranger.userId,
        clientId: client.clientId,
        reason: 'climber_disconnect',
      });
      expect(none).toBe(false);
      await environment.authorize(client);
      const first = await disconnectPartnerConnection(environment.database, {
        userId: client.owner.userId,
        clientId: client.clientId,
        reason: 'climber_disconnect',
      });
      const second = await disconnectPartnerConnection(environment.database, {
        userId: client.owner.userId,
        clientId: client.clientId,
        reason: 'climber_disconnect',
      });
      expect(first).toBe(true);
      expect(second).toBe(false);
      expect((await connectionRow(client)).generation).toBe(1);
    });

    it('forces fresh consent even for a client that would skip it, and reconnect starts a new generation', async () => {
      const client = await environment.createClient();
      await environment.issueTokens(client);
      await disconnectPartnerConnection(environment.database, {
        userId: client.owner.userId,
        clientId: client.clientId,
        reason: 'climber_disconnect',
      });

      const reconnect = await environment.authorize(client);
      expect(reconnect.location).toContain(TEST_OAUTH_OPTIONS.consentPage);
      expect(new URL(reconnect.location!).searchParams.has('code')).toBe(false);

      // A form POST carries prompt in the body, so the fence must set it there too.
      const verifier = randomBytes(32).toString('base64url');
      const formPost = await environment.instance.handler(
        new Request(`${TEST_OAUTH_ISSUER}/oauth2/authorize`, {
          method: 'POST',
          headers: {
            [TEST_SESSION_HEADER]: client.owner.sessionToken,
            origin: 'https://www.boardsesh.test',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            response_type: 'code',
            client_id: client.clientId,
            redirect_uri: client.redirectUri,
            scope: 'profile:read offline_access',
            resource: TEST_RESOURCE,
            state: randomUUID(),
            code_challenge: createHash('sha256').update(verifier).digest('base64url'),
            code_challenge_method: 'S256',
          }),
        }),
      );
      expect(formPost.headers.get('location')).toContain(TEST_OAUTH_OPTIONS.consentPage);

      const accepted = await environment.consent(client.owner, {
        accept: true,
        oauth_query: new URL(reconnect.location!).searchParams.toString(),
      });
      expect(accepted.response.status).toBe(200);
      const connection = await connectionRow(client);
      expect(connection.revokedAt).toBeNull();
      expect(connection.generation).toBe(1);
      const issued = await environment.exchange(client, { location: accepted.body.url!, verifier: reconnect.verifier });
      expect(issued.response.status).toBe(200);
      expect((await environment.introspect(client, issued.body.access_token!)).body.active).toBe(true);
    });

    it('wins against a refresh in flight: nothing issued before it survives', async () => {
      const client = await environment.createClient();
      const unrelated = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const unrelatedTokens = await environment.issueTokens(unrelated);
      const release = await lockConnectionFor(client);
      try {
        const racedRefresh = environment.refresh(client, issued.refresh_token!);
        const racedDisconnect = disconnectPartnerConnection(environment.database, {
          userId: client.owner.userId,
          clientId: client.clientId,
          reason: 'climber_disconnect',
        });
        await waitForBlockedRequests(2);
        await release();
        const [refreshResult] = await Promise.all([racedRefresh, racedDisconnect]);
        if (refreshResult.body.access_token) {
          expect((await environment.introspect(client, refreshResult.body.access_token)).body.active).toBe(false);
          expect((await environment.refresh(client, refreshResult.body.refresh_token!)).body.error).toBe(
            'invalid_grant',
          );
        }
      } finally {
        await release();
      }
      expect((await environment.introspect(client, issued.access_token)).body.active).toBe(false);
      expect((await environment.refresh(client, issued.refresh_token!)).body.error).toBe('invalid_grant');
      expect(
        await db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.clientId, client.clientId)),
      ).toHaveLength(0);
      expect((await environment.introspect(unrelated, unrelatedTokens.access_token)).body.active).toBe(true);
    });
  });

  describe('concurrency on two instances', () => {
    it(
      'a refresh race has exactly one winner, and the loser closes only that family',
      async () => {
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        const independent = await environment.issueTokens(client);
        const release = await lockConnectionFor(client);
        let firstRefresh: ReturnType<typeof environment.refresh>;
        let secondRefresh: ReturnType<typeof environment.refresh>;
        try {
          firstRefresh = environment.refresh(client, issued.refresh_token!, environment.instance);
          secondRefresh = environment.refresh(client, issued.refresh_token!, environment.secondaryInstance);
          await waitForBlockedRequests(2);
        } finally {
          await release();
        }
        const redemptions = await Promise.all([firstRefresh, secondRefresh]);
        const winners = redemptions.filter(({ response }) => response.status === 200);
        expect(winners).toHaveLength(1);
        expect(redemptions.filter(({ body }) => body.error === 'invalid_grant')).toHaveLength(1);
        // The loser found the token consumed, so the winner's new tokens are dead too.
        expect((await environment.introspect(client, winners[0].body.access_token!)).body.active).toBe(false);
        expect((await environment.refresh(client, winners[0].body.refresh_token!)).body.error).toBe('invalid_grant');
        // A second, independent grant for the same app and climber is untouched.
        const independentRefresh = await environment.refresh(client, independent.refresh_token!);
        expect(independentRefresh.response.status).toBe(200);
        expect((await environment.introspect(client, independentRefresh.body.access_token!)).body.active).toBe(true);
      },
      TEST_DEADLINE_MS,
    );

    it(
      'a code redeemed twice at once yields at most one usable token set',
      async () => {
        const client = await environment.createClient();
        const authorization = await environment.authorize(client);
        const release = await lockConnectionFor(client);
        let firstExchange: ReturnType<typeof environment.exchange>;
        let secondExchange: ReturnType<typeof environment.exchange>;
        try {
          firstExchange = environment.exchange(client, authorization, environment.instance);
          secondExchange = environment.exchange(client, authorization, environment.secondaryInstance);
          await waitForBlockedRequests(2);
        } finally {
          await release();
        }
        const results = await Promise.all([firstExchange, secondExchange]);
        // Both ran, one after the other, because the connection lock serializes them.
        expect(results.filter(({ response }) => response.status === 200)).toHaveLength(1);
        expect(results.filter(({ body }) => body.error === 'invalid_grant')).toHaveLength(1);
        const winner = results.find(({ response }) => response.status === 200)!;
        // The contract says never to retry a code: stock replay handling then
        // deletes the tokens that code issued, so a double submit leaves none usable.
        expect((await environment.introspect(client, winner.body.access_token!)).body.active).toBe(false);
        expect((await environment.refresh(client, winner.body.refresh_token!)).body.error).toBe('invalid_grant');
      },
      TEST_DEADLINE_MS,
    );

    it(
      'a held lock on one connection does not delay another',
      async () => {
        const blockedClient = await environment.createClient();
        const freeClient = await environment.createClient();
        const blockedTokens = await environment.issueTokens(blockedClient);
        const freeTokens = await environment.issueTokens(freeClient);
        const release = await lockConnectionFor(blockedClient);
        try {
          const blockedRefresh = environment.refresh(blockedClient, blockedTokens.refresh_token!);
          await waitForBlockedRequests(1);
          const freeRefresh = await environment.refresh(freeClient, freeTokens.refresh_token!);
          expect(freeRefresh.response.status).toBe(200);
          // It finished while the other request was still queued, so it never waited behind it.
          await waitForBlockedRequests(1);
          await release();
          expect((await blockedRefresh).response.status).toBe(200);
        } finally {
          await release();
        }
      },
      TEST_DEADLINE_MS,
    );

    it(
      'an unknown token takes no lock, so strangers cannot queue on a connection',
      async () => {
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        const release = await lockConnectionFor(client);
        try {
          // Queuing on the held row would end in a 503 once the lock timeout passed.
          const unknown = await environment.refresh(client, 'not-a-real-refresh-token');
          expect(unknown.body.error).toBe('invalid_grant');
          // RFC 7009 section 2.2. Stock 1.7.17 answers 400; the guard answers for it.
          const unknownRevoke = await environment.revoke(client, { token: 'not-a-real-token' });
          expect(unknownRevoke.response.status).toBe(200);
        } finally {
          await release();
        }
        expect((await environment.refresh(client, issued.refresh_token!)).response.status).toBe(200);
      },
      TEST_DEADLINE_MS,
    );
  });

  describe('lock order and timeouts', () => {
    it(
      'answers a lock timeout with 503 and Retry-After, never invalid_grant, and keeps the token usable',
      async () => {
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        const release = await lockConnectionFor(client);
        try {
          const refused = await environment.refresh(client, issued.refresh_token!);
          expect(refused.response.status).toBe(503);
          expect(refused.response.headers.get('retry-after')).toBeTruthy();
          expect(refused.body.error).toBe('temporarily_unavailable');
        } finally {
          await release();
        }
        // The transaction rolled back, so the token is still current.
        expect((await environment.refresh(client, issued.refresh_token!)).response.status).toBe(200);
      },
      TEST_DEADLINE_MS,
    );

    it.each([
      ['a password reset', 'no key update'],
      ['an account deletion', 'update'],
    ] as const)(
      'an issuer waits for %s holding the users row FOR %s',
      async (_writer, strength) => {
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        const release = await holdLock((transaction) =>
          transaction.select({ id: users.id }).from(users).where(eq(users.id, client.owner.userId)).for(strength),
        );
        try {
          const blocked = await environment.refresh(client, issued.refresh_token!);
          expect(blocked.response.status).toBe(503);
        } finally {
          await release();
        }
      },
      TEST_DEADLINE_MS,
    );

    it('a foreign-key insert elsewhere (FOR KEY SHARE) does not block an issuer', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const release = await holdLock((transaction) =>
        transaction.select({ id: users.id }).from(users).where(eq(users.id, client.owner.userId)).for('key share'),
      );
      try {
        expect((await environment.refresh(client, issued.refresh_token!)).response.status).toBe(200);
      } finally {
        await release();
      }
    });

    it(
      'two issuers in flight share the users row, and a reset waits for both without deadlocking',
      async () => {
        const firstClient = await environment.createClient();
        const secondClient = await environment.createClient({ owner: firstClient.owner });
        const firstTokens = await environment.issueTokens(firstClient);
        const secondTokens = await environment.issueTokens(secondClient);
        let issuersInFlight = 0;
        let bothInFlight!: () => void;
        const bothAreInFlight = new Promise<void>((resolve) => {
          bothInFlight = resolve;
        });
        let releaseIssuers!: () => void;
        const issuersReleased = new Promise<void>((resolve) => {
          releaseIssuers = resolve;
        });
        // Parks each issuer after it has minted, while it still holds FOR SHARE.
        const pausingInstance = environment.createInstance([
          {
            id: 'test-pause-issuer',
            hooks: {
              after: [
                {
                  matcher: (context) => context.path === '/oauth2/token',
                  handler: createAuthMiddleware(async () => {
                    issuersInFlight += 1;
                    if (issuersInFlight === 2) bothInFlight();
                    await issuersReleased;
                  }),
                },
              ],
            },
          },
        ]);
        const firstRefresh = environment.refresh(firstClient, firstTokens.refresh_token!, pausingInstance);
        const secondRefresh = environment.refresh(secondClient, secondTokens.refresh_token!, pausingInstance);
        await bothAreInFlight;

        // The trigger's lock, on a connection tagged so the wait can be observed.
        const reset = environment.database.transaction(async (transaction) => {
          await transaction
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, firstClient.owner.userId))
            .for('no key update');
        });
        await waitForBlockedRequests(1);
        releaseIssuers();

        const [first, second] = await Promise.all([firstRefresh, secondRefresh, reset]);
        expect(first.response.status).toBe(200);
        expect(second.response.status).toBe(200);
      },
      TEST_DEADLINE_MS,
    );

    it(
      'maps a lock timeout inside a provider statement to 503 as well, and rolls the whole request back',
      async () => {
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        const refreshLookup = await hashForTest(issued.refresh_token!);
        const release = await holdLock((transaction) =>
          transaction
            .select({ id: oauthRefreshToken.id })
            .from(oauthRefreshToken)
            .where(eq(oauthRefreshToken.token, refreshLookup))
            .for('update'),
        );
        try {
          const refused = await environment.refresh(client, issued.refresh_token!);
          expect(refused.response.status).toBe(503);
          expect(refused.body.error).toBe('temporarily_unavailable');
        } finally {
          await release();
        }
        expect((await environment.refresh(client, issued.refresh_token!)).response.status).toBe(200);
      },
      TEST_DEADLINE_MS,
    );

    it(
      'revoking an access token waits for the connection lock too',
      async () => {
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        const release = await lockConnectionFor(client);
        try {
          const refused = await environment.revoke(client, { token: issued.access_token });
          expect(refused.response.status).toBe(503);
        } finally {
          await release();
        }
        const revoked = await environment.revoke(client, { token: issued.access_token });
        expect(revoked.response.status).toBe(200);
        expect((await environment.introspect(client, issued.access_token)).body.active).toBe(false);
      },
      TEST_DEADLINE_MS,
    );

    it(
      'a revocation that writes nothing referencing users still waits for the users row',
      async () => {
        // Deleting an access token touches no foreign key to users, so only the
        // explicit lock can make this wait.
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        const release = await holdLock((transaction) =>
          transaction
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, client.owner.userId))
            .for('no key update'),
        );
        try {
          expect((await environment.revoke(client, { token: issued.access_token })).response.status).toBe(503);
        } finally {
          await release();
        }
      },
      TEST_DEADLINE_MS,
    );

    it('every request transaction runs with the planned limits, scoped to that transaction', async () => {
      const readLimits = () =>
        sql`select current_setting('lock_timeout') as "lockTimeout",
                   current_setting('statement_timeout') as "statementTimeout",
                   current_setting('idle_in_transaction_session_timeout') as "idleTimeout"`;
      const [inside] = await runInPartnerTransaction(environment.database, (transaction) =>
        transaction.execute(readLimits()),
      );
      expect(inside).toEqual({ lockTimeout: '2s', statementTimeout: '5s', idleTimeout: '10s' });
      // Three concurrent reads land on all three pooled connections.
      const outside = await Promise.all([1, 2, 3].map(() => environment.database.execute(readLimits())));
      for (const [limits] of outside) expect(limits.lockTimeout).not.toBe('2s');
    });

    it('takes no lock at all when the account has been deleted', async () => {
      await expect(
        runInPartnerTransaction(environment.database, (transaction) =>
          lockCurrentGrant(transaction, {
            userId: 'missing-user',
            clientId: 'missing-client',
            authorizationCodeId: 'missing-code',
          }),
        ),
      ).resolves.toBe(false);
    });
  });

  it('refuses to bind a code to a connection that was disconnected without fresh consent', async () => {
    const client = await environment.createClient();
    await environment.issueTokens(client);
    // Runs in the request transaction after the provider issued the code, standing in
    // for any path that reaches issuance on a revoked connection without consent.
    const revokingInstance = environment.createInstance([
      {
        id: 'test-revoke-before-issuance-finishes',
        hooks: {
          after: [
            {
              matcher: (context) => context.path === '/oauth2/authorize',
              handler: createAuthMiddleware(async () => {
                await currentPartnerTransaction()
                  .transaction.update(oauthConnections)
                  .set({ revokedAt: new Date() })
                  .where(eq(oauthConnections.clientId, client.clientId));
              }),
            },
          ],
        },
      },
    ]);
    const authorization = await environment.authorize(client, {}, revokingInstance);
    expect(authorization.response.status).toBe(500);
    // The whole request rolled back: the connection is untouched and no code is left behind.
    expect((await connectionRow(client)).revokedAt).toBeNull();
    const codes = await db.select().from(oauthVerification);
    expect(
      codes.filter((record) => (JSON.parse(record.value) as { userId?: string }).userId === client.owner.userId),
    ).toHaveLength(0);
  });

  it('fails closed outside a partner request transaction', async () => {
    const client = await environment.createClient();
    const issued = await environment.issueTokens(client);
    // A route wired past the transaction wrapper would run the guard with no transaction.
    await expect(
      environment.auth.handler(
        new Request(`${TEST_OAUTH_ISSUER}/oauth2/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: issued.refresh_token!,
            client_id: client.clientId,
            client_secret: client.clientSecret!,
          }),
        }),
      ),
    ).rejects.toThrow(/outside a partner request transaction/);
    const [row] = await db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.clientId, client.clientId));
    expect(row.revoked).toBeNull();
  });

  describe('connection rows wait for a code', () => {
    const consentlessConnections = (userId: string) =>
      db.select().from(oauthConnections).where(eq(oauthConnections.userId, userId));

    it('a rejected authorize leaves no row', async () => {
      const client = await environment.createClient();
      const climber = await environment.createClimber();
      const url = new URL(`${TEST_OAUTH_ISSUER}/oauth2/authorize`);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: client.clientId,
        redirect_uri: 'https://evil.example/not-registered',
        scope: 'profile:read',
        code_challenge: 'x'.repeat(43),
        code_challenge_method: 'S256',
      }).toString();
      const response = await environment.instance.handler(
        new Request(url, { headers: { [TEST_SESSION_HEADER]: climber.sessionToken } }),
      );
      expect(new URL(response.headers.get('location')!).searchParams.has('code')).toBe(false);
      expect(await consentlessConnections(climber.userId)).toEqual([]);
    });

    it('showing the consent screen leaves no row, and approving creates it', async () => {
      const client = await environment.createClient({ skipConsent: false });
      const atConsent = await environment.authorize(client);
      expect(atConsent.location).toContain(TEST_OAUTH_OPTIONS.consentPage);
      expect(await consentlessConnections(client.owner.userId)).toEqual([]);
      const denied = await environment.consent(client.owner, {
        accept: false,
        oauth_query: new URL(atConsent.location!).searchParams.toString(),
      });
      expect(new URL(denied.body.url!).searchParams.get('error')).toBe('access_denied');
      expect(await consentlessConnections(client.owner.userId)).toEqual([]);

      // A consent link answers once: the denied one cannot be approved afterwards.
      const reused = await environment.consent(client.owner, {
        accept: true,
        oauth_query: new URL(atConsent.location!).searchParams.toString(),
      });
      expect(reused.response.status).toBe(400);
      expect(await consentlessConnections(client.owner.userId)).toEqual([]);

      const again = await environment.authorize(client);
      const accepted = await environment.consent(client.owner, {
        accept: true,
        oauth_query: new URL(again.location!).searchParams.toString(),
      });
      expect(accepted.response.status).toBe(200);
      const rows = await consentlessConnections(client.owner.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0].connectedAt).toBeNull();
      expect(
        (await environment.exchange(client, { location: accepted.body.url!, verifier: again.verifier })).response
          .status,
      ).toBe(200);
      expect((await consentlessConnections(client.owner.userId))[0].connectedAt).not.toBeNull();
    });

    it(
      'still holds the users row with no connection yet, so a reset waits for the code being minted',
      async () => {
        const client = await environment.createClient({ skipConsent: false });
        const release = await holdLock((transaction) =>
          transaction
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, client.owner.userId))
            .for('no key update'),
        );
        try {
          // This request reaches only the consent redirect: no insert, so only the fence can wait here.
          expect((await environment.authorize(client)).response.status).toBe(503);
        } finally {
          await release();
        }
      },
      TEST_DEADLINE_MS,
    );

    it('two first-time authorizes bind to one row', async () => {
      const client = await environment.createClient();
      const [first, second] = await Promise.all([
        environment.authorize(client, {}, environment.instance),
        environment.authorize(client, {}, environment.secondaryInstance),
      ]);
      expect(first.response.status).toBe(302);
      expect(second.response.status).toBe(302);
      const rows = await consentlessConnections(client.owner.userId);
      expect(rows).toHaveLength(1);
      expect(await db.select().from(oauthGrants).where(eq(oauthGrants.connectionId, rows[0].id))).toHaveLength(2);
    });
  });

  describe('database failures', () => {
    function captureOutput() {
      const written: string[] = [];
      const record = (...args: unknown[]) => {
        written.push(args.map((argument) => inspect(argument, { depth: 6 })).join(' '));
        return true;
      };
      const spies = [
        vi.spyOn(process.stderr, 'write').mockImplementation(record),
        vi.spyOn(process.stdout, 'write').mockImplementation(record),
        ...(['error', 'warn', 'log', 'info', 'debug'] as const).map((level) =>
          vi.spyOn(console, level).mockImplementation(record),
        ),
      ];
      return {
        text: () => written.join('\n'),
        restore: () => spies.forEach((spy) => spy.mockRestore()),
      };
    }

    function expectNoQueryDetails(output: string, client: TestClient) {
      expect(output).not.toMatch(/params:|Failed query/);
      expect(output).not.toContain(client.owner.userId);
      expect(output).not.toContain(client.clientId);
    }

    it(
      'a lock timeout in a guard prints no query parameters',
      async () => {
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        const release = await lockConnectionFor(client);
        const output = captureOutput();
        try {
          const refused = await environment.refresh(client, issued.refresh_token!);
          expect(refused.response.status).toBe(503);
        } finally {
          output.restore();
          await release();
        }
        expectNoQueryDetails(output.text(), client);
      },
      TEST_DEADLINE_MS,
    );

    it(
      'a lock timeout in a provider statement prints no query parameters',
      async () => {
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        const refreshLookup = await hashForTest(issued.refresh_token!);
        const release = await holdLock((transaction) =>
          transaction
            .select({ id: oauthRefreshToken.id })
            .from(oauthRefreshToken)
            .where(eq(oauthRefreshToken.token, refreshLookup))
            .for('update'),
        );
        const output = captureOutput();
        try {
          expect((await environment.refresh(client, issued.refresh_token!)).response.status).toBe(503);
        } finally {
          output.restore();
          await release();
        }
        expectNoQueryDetails(output.text(), client);
      },
      TEST_DEADLINE_MS,
    );

    it(
      'a lock timeout inside stock revoke answers 503 and prints no query parameters',
      async () => {
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        const accessLookup = await hashForTest(issued.access_token);
        const release = await holdLock((transaction) =>
          transaction
            .select({ id: oauthAccessToken.id })
            .from(oauthAccessToken)
            .where(eq(oauthAccessToken.token, accessLookup))
            .for('update'),
        );
        const output = captureOutput();
        try {
          const refused = await environment.revoke(client, { token: issued.access_token });
          expect(refused.response.status).toBe(503);
          expect(refused.body.error).toBe('temporarily_unavailable');
        } finally {
          output.restore();
          await release();
        }
        expectNoQueryDetails(output.text(), client);
      },
      TEST_DEADLINE_MS,
    );

    it('an unexpected query failure answers a bare 500 and logs only the name and code', async () => {
      const client = await environment.createClient();
      const authorization = await environment.authorize(client);
      const failingInstance = environment.createInstance([
        {
          id: 'test-unexpected-query-failure',
          hooks: {
            after: [
              {
                matcher: (context) => context.path === '/oauth2/token',
                handler: createAuthMiddleware(async (context) => {
                  // A duplicate client id: a real query failure, not a lock wait.
                  await context.context.adapter.create({
                    model: 'oauthClient',
                    data: { clientId: client.clientId, redirectUris: ['https://client.example.test/duplicate'] },
                  });
                }),
              },
            ],
          },
        },
      ]);
      const logged = vi.spyOn(logger, 'error').mockImplementation(() => logger);
      const output = captureOutput();
      let failed: Awaited<ReturnType<typeof environment.exchange>>;
      try {
        failed = await environment.exchange(client, authorization, failingInstance);
      } finally {
        output.restore();
      }
      expect(failed.response.status).toBe(500);
      expect(failed.body).toEqual({});
      expect(logged).toHaveBeenCalledWith('Partner OAuth request failed', {
        errorName: 'PartnerDatabaseError',
        postgresCode: '23505',
      });
      logged.mockRestore();
      expectNoQueryDetails(output.text(), client);
      expect(await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.clientId, client.clientId))).toEqual(
        [],
      );
    });

    it.each(['55P03', '57014', '40P01'])('answers 503 for retryable database error %s', async (code) => {
      const response = await handlePartnerRequest(
        environment.database,
        new Request(`${TEST_OAUTH_ISSUER}/oauth2/token`),
        () => Promise.reject(Object.assign(new Error('injected'), { code })),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBeTruthy();
    });

    it('answers 503 when the retryable code is wrapped, as Drizzle wraps it', async () => {
      const response = await handlePartnerRequest(
        environment.database,
        new Request(`${TEST_OAUTH_ISSUER}/oauth2/token`),
        () => Promise.reject(new Error('wrapped', { cause: Object.assign(new Error('inner'), { code: '40P01' }) })),
      );
      expect(response.status).toBe(503);
    });

    it('answers a bare 500 for anything else', async () => {
      const logged = vi.spyOn(logger, 'error').mockImplementation(() => logger);
      try {
        const response = await handlePartnerRequest(
          environment.database,
          new Request(`${TEST_OAUTH_ISSUER}/oauth2/token`),
          () => Promise.reject(Object.assign(new Error('injected'), { code: '23505' })),
        );
        expect(response.status).toBe(500);
        expect(await response.text()).toBe('');
      } finally {
        logged.mockRestore();
      }
    });
  });

  describe('a spent authorization code', () => {
    const holdClimberRow = (client: TestClient) =>
      holdLock((transaction) =>
        transaction.select({ id: users.id }).from(users).where(eq(users.id, client.owner.userId)).for('no key update'),
      );

    async function spendCode(client: TestClient) {
      const authorization = await environment.authorize(client);
      const issued = await environment.exchange(client, authorization);
      expect(issued.response.status).toBe(200);
      return { authorization, issued };
    }

    it(
      'takes no lock once nothing is left to clean up',
      async () => {
        const client = await environment.createClient();
        const { authorization } = await spendCode(client);
        const firstReplay = await environment.exchange(client, authorization);
        expect(firstReplay.response.status).toBe(400);
        expect(firstReplay.body.error).toBe('invalid_grant');
        expect(
          await db
            .select({ id: oauthAccessToken.id })
            .from(oauthAccessToken)
            .where(eq(oauthAccessToken.clientId, client.clientId)),
        ).toEqual([]);

        const release = await holdClimberRow(client);
        try {
          const started = performance.now();
          const replays = await Promise.all(
            Array.from({ length: 6 }, () => environment.exchange(client, authorization)),
          );
          // Queuing behind the row lock would end in a 503 after the 2 s lock timeout.
          expect(performance.now() - started).toBeLessThan(1000);
          expect(replays.map((replay) => replay.body.error)).toEqual(Array.from({ length: 6 }, () => 'invalid_grant'));
        } finally {
          await release();
        }
      },
      TEST_DEADLINE_MS,
    );

    it(
      'still locks while tokens from the code remain, so replay cleanup stays fenced',
      async () => {
        const client = await environment.createClient();
        const { authorization } = await spendCode(client);
        const release = await holdClimberRow(client);
        try {
          const firstReplay = await environment.exchange(client, authorization);
          // The replay had to wait on the climber's row, then gave up.
          expect(firstReplay.response.status).toBe(503);
        } finally {
          await release();
        }
      },
      TEST_DEADLINE_MS,
    );

    it(
      'still locks a live code, so redemption stays fenced',
      async () => {
        const client = await environment.createClient();
        const authorization = await environment.authorize(client);
        const release = await holdClimberRow(client);
        try {
          const redemption = await environment.exchange(client, authorization);
          expect(redemption.response.status).toBe(503);
        } finally {
          await release();
        }
        expect((await environment.exchange(client, authorization)).response.status).toBe(200);
      },
      TEST_DEADLINE_MS,
    );

    /** Fails the provider's own checks before it would consume the code or clean up. */
    const replayWithoutVerifier = (client: TestClient, authorization: { location: string | null }) =>
      postForm(environment.instance, '/oauth2/token', {
        grant_type: 'authorization_code',
        code: new URL(authorization.location!).searchParams.get('code')!,
        redirect_uri: client.redirectUri,
        ...clientCredentials(client),
      });

    const tokenRowCounts = async (client: TestClient) => ({
      access: (
        await db
          .select({ id: oauthAccessToken.id })
          .from(oauthAccessToken)
          .where(eq(oauthAccessToken.clientId, client.clientId))
      ).length,
      refresh: (
        await db
          .select({ id: oauthRefreshToken.id })
          .from(oauthRefreshToken)
          .where(eq(oauthRefreshToken.clientId, client.clientId))
      ).length,
    });

    it(
      'closes the tokens on the first replay the provider would refuse, so the lock is taken once',
      async () => {
        const client = await environment.createClient();
        const { authorization } = await spendCode(client);
        const firstReplay = await replayWithoutVerifier(client, authorization);
        expect(firstReplay.body.error).toBe('invalid_grant');
        expect(await tokenRowCounts(client)).toEqual({ access: 0, refresh: 0 });

        const release = await holdClimberRow(client);
        try {
          const started = performance.now();
          const replays = await Promise.all(
            Array.from({ length: 6 }, () => replayWithoutVerifier(client, authorization)),
          );
          expect(performance.now() - started).toBeLessThan(1000);
          expect(replays.map((replay) => replay.body.error)).toEqual(Array.from({ length: 6 }, () => 'invalid_grant'));
        } finally {
          await release();
        }
      },
      TEST_DEADLINE_MS,
    );

    it(
      'takes rotated tokens and their ancestry with it, as the provider does for its whole family',
      async () => {
        const client = await environment.createClient();
        const { authorization, issued } = await spendCode(client);
        const rotated = await environment.refresh(client, issued.body.refresh_token!);
        expect(rotated.response.status).toBe(200);
        expect((await tokenRowCounts(client)).refresh).toBeGreaterThan(0);

        expect((await replayWithoutVerifier(client, authorization)).body.error).toBe('invalid_grant');

        expect(await tokenRowCounts(client)).toEqual({ access: 0, refresh: 0 });
        expect(
          await db.select().from(oauthRefreshAncestors).where(eq(oauthRefreshAncestors.clientId, client.clientId)),
        ).toEqual([]);
        expect((await environment.refresh(client, rotated.body.refresh_token!)).body.error).toBe('invalid_grant');
      },
      TEST_DEADLINE_MS,
    );

    it(
      'still locks while only a refresh token from the code remains',
      async () => {
        const client = await environment.createClient();
        const { authorization } = await spendCode(client);
        await db.delete(oauthAccessToken).where(eq(oauthAccessToken.clientId, client.clientId));
        const release = await holdClimberRow(client);
        try {
          expect((await replayWithoutVerifier(client, authorization)).response.status).toBe(503);
        } finally {
          await release();
        }
      },
      TEST_DEADLINE_MS,
    );

    it(
      'treats an expired code that was never redeemed as spent, without the lock',
      async () => {
        const client = await environment.createClient();
        const authorization = await environment.authorize(client);
        const code = new URL(authorization.location!).searchParams.get('code')!;
        await db
          .update(oauthVerification)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(oauthVerification.identifier, await hashForTest(code)));
        const release = await holdClimberRow(client);
        try {
          const started = performance.now();
          expect((await replayWithoutVerifier(client, authorization)).body.error).toBe('invalid_grant');
          expect(performance.now() - started).toBeLessThan(1000);
        } finally {
          await release();
        }
      },
      TEST_DEADLINE_MS,
    );

    it(
      'refuses an expired refresh token without the lock',
      async () => {
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        await db
          .update(oauthRefreshToken)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(oauthRefreshToken.token, await hashForTest(issued.refresh_token!)));
        const release = await holdClimberRow(client);
        try {
          const started = performance.now();
          const refused = await environment.refresh(client, issued.refresh_token!, environment.instance);
          // Queuing on the held row would end in a 503 after the 2 s lock timeout.
          expect(performance.now() - started).toBeLessThan(1000);
          expect(refused.body.error).toBe('invalid_grant');
        } finally {
          await release();
        }
      },
      TEST_DEADLINE_MS,
    );

    it(
      'still lets an expired used token trip reuse, taking the lock only for the first replay',
      async () => {
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        const rotated = await environment.refresh(client, issued.refresh_token!, environment.instance);
        expect(rotated.response.status).toBe(200);
        const consumedHash = await hashForTest(issued.refresh_token!);
        const pastExpiry = new Date(Date.now() - 1000);
        await db
          .update(oauthRefreshToken)
          .set({ expiresAt: pastExpiry })
          .where(eq(oauthRefreshToken.token, consumedHash));
        await db
          .update(oauthRefreshAncestors)
          .set({ expiresAt: pastExpiry })
          .where(eq(oauthRefreshAncestors.tokenHash, consumedHash));

        // The first replay closes the family, as an unexpired replay would.
        expect((await environment.refresh(client, issued.refresh_token!, environment.instance)).body.error).toBe(
          'invalid_grant',
        );
        expect((await environment.refresh(client, rotated.body.refresh_token!, environment.instance)).body.error).toBe(
          'invalid_grant',
        );

        // Its rows are gone, so a later replay takes no lock.
        const release = await holdClimberRow(client);
        try {
          const started = performance.now();
          const refused = await environment.refresh(client, issued.refresh_token!, environment.instance);
          expect(performance.now() - started).toBeLessThan(1000);
          expect(refused.body.error).toBe('invalid_grant');
        } finally {
          await release();
        }
      },
      TEST_DEADLINE_MS,
    );

    it(
      'leaves no usable token when a redemption and a replay race',
      async () => {
        const client = await environment.createClient();
        const authorization = await environment.authorize(client);
        const results = await Promise.all([
          environment.exchange(client, authorization),
          environment.exchange(client, authorization, environment.secondaryInstance),
        ]);
        const statuses = results.map((result) => result.response.status).sort((first, second) => first - second);
        // One redeems; the loser finds the code gone and closes what it issued.
        expect(statuses).toEqual([200, 400]);
        expect(await tokenRowCounts(client)).toEqual({ access: 0, refresh: 0 });
      },
      TEST_DEADLINE_MS,
    );

    it(
      'survives concurrent first replays with no server error',
      async () => {
        const client = await environment.createClient();
        const { authorization } = await spendCode(client);
        const replays = await Promise.all(
          Array.from({ length: 8 }, () => replayWithoutVerifier(client, authorization)),
        );
        expect(replays.map((replay) => replay.response.status)).toEqual(Array.from({ length: 8 }, () => 400));
        expect(await tokenRowCounts(client)).toEqual({ access: 0, refresh: 0 });
      },
      TEST_DEADLINE_MS,
    );

    const PRECONDITION_DESCRIPTION = 'Either code_verifier or client_secret is required';

    /** A token request with a Basic credential, which `postForm` cannot send. */
    async function postWithBasic(client: TestClient, fields: Record<string, string>) {
      const encode = (value: string) => new URLSearchParams({ value }).toString().slice('value='.length);
      const credential = Buffer.from(`${encode(client.clientId)}:${encode(client.clientSecret!)}`).toString('base64');
      const response = await environment.instance.handler(
        new Request(`${TEST_OAUTH_ISSUER}/oauth2/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${credential}` },
          body: new URLSearchParams(fields),
        }),
      );
      return { response, body: (await response.json()) as { error?: string; error_description?: string } };
    }

    const codeOf = (authorization: { location: string | null }) =>
      new URL(authorization.location!).searchParams.get('code')!;

    it.each([
      ['no code_verifier', {}],
      ['an empty code_verifier', { code_verifier: '' }],
    ])(
      'refuses a public app with %s before the lock, and leaves the code usable',
      async (_label, verifierField) => {
        const client = await environment.createClient({ publicClient: true });
        const authorization = await environment.authorize(client);
        const release = await holdClimberRow(client);
        try {
          const started = performance.now();
          const refused = await postForm(environment.instance, '/oauth2/token', {
            grant_type: 'authorization_code',
            code: codeOf(authorization),
            redirect_uri: client.redirectUri,
            client_id: client.clientId,
            ...verifierField,
          });
          // Queuing behind the row lock would end in a 503 after the 2 s lock timeout.
          expect(performance.now() - started).toBeLessThan(1000);
          expect(refused.response.status).toBe(400);
          expect(refused.body).toMatchObject({ error: 'invalid_request', error_description: PRECONDITION_DESCRIPTION });
        } finally {
          await release();
        }
        expect((await environment.exchange(client, authorization)).response.status).toBe(200);
      },
      TEST_DEADLINE_MS,
    );

    it(
      'lets a confidential app sending its secret in the form reach the provider without a verifier',
      async () => {
        const client = await environment.createClient();
        const authorization = await environment.authorize(client);
        const answered = await postForm(environment.instance, '/oauth2/token', {
          grant_type: 'authorization_code',
          code: codeOf(authorization),
          redirect_uri: client.redirectUri,
          ...clientCredentials(client),
        });
        // The provider decides, and asks for PKCE because every app registers with it.
        expect(answered.body.error).toBe('invalid_request');
        expect(answered.body.error_description).not.toBe(PRECONDITION_DESCRIPTION);
      },
      TEST_DEADLINE_MS,
    );

    it(
      'lets a confidential app sending its secret by Basic reach the provider without a verifier',
      async () => {
        const client = await environment.createClient({ secretMethod: 'client_secret_basic' });
        const authorization = await environment.authorize(client);
        const answered = await postWithBasic(client, {
          grant_type: 'authorization_code',
          code: codeOf(authorization),
          redirect_uri: client.redirectUri,
        });
        expect(answered.body.error).toBe('invalid_request');
        expect(answered.body.error_description).not.toBe(PRECONDITION_DESCRIPTION);
      },
      TEST_DEADLINE_MS,
    );

    it(
      'still accepts every legitimate exchange: public, secret in the form, and secret by Basic',
      async () => {
        const publicClient = await environment.createClient({ publicClient: true });
        expect(
          (await environment.exchange(publicClient, await environment.authorize(publicClient))).response.status,
        ).toBe(200);
        const postClient = await environment.createClient();
        expect((await environment.exchange(postClient, await environment.authorize(postClient))).response.status).toBe(
          200,
        );
        const basicClient = await environment.createClient({ secretMethod: 'client_secret_basic' });
        const authorization = await environment.authorize(basicClient);
        const answered = await postWithBasic(basicClient, {
          grant_type: 'authorization_code',
          code: codeOf(authorization),
          code_verifier: authorization.verifier,
          redirect_uri: basicClient.redirectUri,
        });
        expect(answered.response.status).toBe(200);
      },
      TEST_DEADLINE_MS,
    );
  });
});
