import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import { users } from '@boardsesh/db/schema/auth';
import { db } from '../db/client';
import { buildHttpConnectionContext } from '../graphql/yoga';
import { firstPartyToken, nowSeconds, webSessionBearer } from './helpers/partner-launch-harness';

/**
 * #7598 added `webSignIn` to the HTTP context for the developer console's
 * recent sign-in gate. It must add a fact and change nothing else: a www
 * session whose cookie has no `auth_time` (every session from before #7366, and
 * any sign-in made while links were unguarded) authenticates exactly as before,
 * and only the console's gated changes look at its age.
 */

async function createClimber(): Promise<string> {
  const userId = `web-sign-in-${randomUUID()}`;
  await db.insert(users).values({ id: userId, email: `${userId}@example.invalid` });
  return userId;
}

function contextFor(bearer: string) {
  return buildHttpConnectionContext({
    request: new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}` },
    }),
  });
}

describe('the HTTP context and the www sign-in time', () => {
  it('authenticates a session cookie with no auth_time as before, and calls its age unknown', async () => {
    const userId = await createClimber();
    for (const webMode of ['allowlist', 'off']) {
      const context = await contextFor(
        await webSessionBearer(userId, { webMode, migrated: { withoutAuthTime: true } }),
      );
      expect(context).toMatchObject({
        userId,
        isAuthenticated: true,
        authCredentialProvided: true,
        credentialExpiresAt: expect.any(Number),
        webSignIn: { authenticatedAtMs: null, linkGuarded: webMode === 'allowlist' },
      });
    }
  });

  it('carries the sign-in time a cookie proves', async () => {
    const userId = await createClimber();
    const authTime = nowSeconds() - 600;
    const context = await contextFor(await webSessionBearer(userId, { webMode: 'allowlist', authTime }));
    expect(context).toMatchObject({
      userId,
      isAuthenticated: true,
      webSignIn: { authenticatedAtMs: authTime * 1000, linkGuarded: true },
    });
  });

  it('gives an app token no web sign-in, and authenticates it as before', async () => {
    const userId = await createClimber();
    const context = await contextFor(await firstPartyToken(userId));
    expect(context).toMatchObject({ userId, isAuthenticated: true });
    expect(context.webSignIn).toBeUndefined();
  });
});
