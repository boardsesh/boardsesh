import { randomUUID } from 'node:crypto';
import type { BetterAuthPlugin, User } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import { PROTOTYPE_ISSUER } from '../oauth-options';

/**
 * This is an extension-API proof, not a production legacy credential bridge.
 * The identity/lineage below comes from the test process, never from a request.
 * Signature validation, persistent idempotency and revocation tombstones remain
 * separate gates; a real bridge must enforce them before creating a session.
 */
function ageProofPlugin(userId: string): BetterAuthPlugin {
  return {
    id: 'boardsesh-prototype-age-proof',
    endpoints: {
      prototypeAgeProof: createAuthEndpoint('/prototype-age-proof', { method: 'POST' }, async (context) => {
        const user = await context.context.adapter.findOne<User>({
          model: 'user',
          where: [{ field: 'id', value: userId }],
        });
        if (!user) throw new APIError('UNAUTHORIZED');
        // The documented plugin context owns session creation; no private
        // module imports or disabling of freshness validation are required.
        const session = await context.context.internalAdapter.createSession(user.id);
        if (!session) throw new APIError('UNAUTHORIZED');
        await setSessionCookie(context, { session, user });
        return context.json({ userId: user.id });
      }),
    },
  };
}

function request(path: string, cookie?: string, method: 'GET' | 'POST' = 'GET') {
  return new Request(`${PROTOTYPE_ISSUER}${path}`, {
    method,
    headers: {
      origin: 'https://www.boardsesh.test',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
}

describe('documented plugin and database-hook preservation of authentication age', () => {
  let environment: Awaited<ReturnType<typeof createPrototypeEnvironment>>;
  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
  });
  afterAll(async () => environment?.close());

  it.each(['known-old', 'unknown', 'known-fresh'] as const)(
    'retains %s authentication age through session creation and renewal',
    async (age) => {
      const userId = randomUUID();
      await environment.database.insert(environment.schema.user).values({
        id: userId,
        email: `${userId}@example.com`,
        name: 'Age proof fixture',
        emailVerified: false,
      });
      const now = Date.now();
      const originalAuthenticatedAt =
        age === 'unknown' ? null : new Date(now - (age === 'known-old' ? 24 * 60 * 60 * 1000 : 60_000));
      // Unknown age gets an explicitly stale sentinel, never the migration time.
      const originalCreatedAt = originalAuthenticatedAt ?? new Date(0);
      const lineageId = `synthetic-lineage-${userId}`;
      const authority = environment.createAuthority({
        plugins: [ageProofPlugin(userId)],
        session: { updateAge: 1, expiresIn: 3600 },
        databaseHooks: {
          session: {
            create: {
              async before(session, context) {
                if (context?.path !== '/prototype-age-proof') return;
                return {
                  data: {
                    ...session,
                    createdAt: originalCreatedAt,
                    updatedAt: originalCreatedAt,
                    expiresAt: new Date(now + 30_000),
                    originalAuthenticatedAt,
                    legacyLineageId: lineageId,
                  },
                };
              },
            },
          },
        },
      });
      const creation = await authority.handler(request('/prototype-age-proof', undefined, 'POST'));
      expect(creation.status).toBe(200);
      const cookieHeader = creation.headers
        .getSetCookie()
        .find((cookie) => cookie.includes('better-auth.session_token='));
      expect(cookieHeader).toBeDefined();
      const cookie = cookieHeader!.split(';')[0];
      const [created] = await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, userId));
      expect(created.createdAt).toEqual(originalCreatedAt);
      expect(created.originalAuthenticatedAt).toEqual(originalAuthenticatedAt);
      expect(created.legacyLineageId).toBe(lineageId);

      // The short fixture expiry makes renewal due immediately, without timers.
      const ordinary = await authority.handler(request('/get-session', cookie));
      expect(ordinary.status).toBe(200);
      expect(await ordinary.json()).toMatchObject({
        user: { id: userId },
        session: { createdAt: originalCreatedAt.toISOString() },
      });
      const [renewed] = await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.id, created.id));
      expect(renewed.expiresAt.getTime()).toBeGreaterThan(created.expiresAt.getTime());
      expect(renewed.createdAt).toEqual(originalCreatedAt);
      expect(renewed.originalAuthenticatedAt).toEqual(originalAuthenticatedAt);
      expect(renewed.legacyLineageId).toBe(lineageId);

      const sensitive = await authority.handler(request('/list-sessions', cookie));
      expect(sensitive.status).toBe(age === 'known-fresh' ? 200 : 403);
      if (age !== 'known-fresh') expect(await sensitive.json()).toMatchObject({ code: 'SESSION_NOT_FRESH' });
    },
  );
});
