import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createAuthMiddleware } from 'better-auth/api';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
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
import { disconnectPartnerConnection } from '../connection';
import { lockCurrentGrant } from '../locks';
import { currentPartnerTransaction, runInPartnerTransaction } from '../transaction';
import {
  createPartnerTestEnvironment,
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

  it('binds a code to the connection generation and marks the connection connected', async () => {
    const client = await environment.createClient();
    const authorization = await environment.authorize(client);
    expect(authorization.response.status).toBe(302);
    const connection = await connectionRow(client);
    expect(connection.userId).toBe(client.owner.userId);
    expect(connection.generation).toBe(0);
    expect(connection.connectedAt).not.toBeNull();
    const grants = await db.select().from(oauthGrants).where(eq(oauthGrants.connectionId, connection.id));
    expect(grants).toHaveLength(1);
    expect(grants[0].generation).toBe(0);
    // The grant key is the hash the code row is stored under.
    const [code] = await db
      .select()
      .from(oauthVerification)
      .where(eq(oauthVerification.identifier, grants[0].authorizationCodeId));
    expect(code).toBeDefined();
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
      const client = await environment.createClient();
      const unrelated = await environment.createClient({ owner: client.owner });
      const issued = await environment.issueTokens(client);
      const rotated = await environment.refresh(client, issued.refresh_token!);
      expect(rotated.response.status).toBe(200);
      const pending = await environment.authorize(client);
      const unrelatedTokens = await environment.issueTokens(unrelated);

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
          // Stock 1.7.17 answers an unknown token with 400 rather than RFC 7009's 200.
          const unknownRevoke = await environment.revoke(client, { token: 'not-a-real-token' });
          expect(unknownRevoke.response.status).toBe(400);
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

    it(
      'an issuer waits for a reset holding the users row FOR UPDATE',
      async () => {
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        const release = await holdLock((transaction) =>
          transaction.select({ id: users.id }).from(users).where(eq(users.id, client.owner.userId)).for('update'),
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

    it('ordinary user updates (FOR NO KEY UPDATE) do not block an issuer', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client);
      const release = await holdLock((transaction) =>
        transaction.select({ id: users.id }).from(users).where(eq(users.id, client.owner.userId)).for('no key update'),
      );
      try {
        expect((await environment.refresh(client, issued.refresh_token!)).response.status).toBe(200);
      } finally {
        await release();
      }
    });

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
        // A token insert would take KEY SHARE through its foreign key anyway. Deleting
        // an access token does not, so only the explicit lock can make this wait.
        const client = await environment.createClient();
        const issued = await environment.issueTokens(client);
        const release = await holdLock((transaction) =>
          transaction.select({ id: users.id }).from(users).where(eq(users.id, client.owner.userId)).for('update'),
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
    const response = await environment.auth.handler(
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
    );
    expect(response.status).toBe(500);
    const [row] = await db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.clientId, client.clientId));
    expect(row.revoked).toBeNull();
  });
});
