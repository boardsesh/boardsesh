/**
 * #7596 B3a over real HTTP and PostgreSQL: the private access command (the one
 * place a web session rolls) and `validateToken`'s browser branch, whose
 * admission is the cookie read's own live-session check on every call.
 */
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { isSignInGoodForPartnerAppChange } from '@boardsesh/auth-protocol/auth-time';
import {
  BROWSER_ACCESS_TOKEN_LIFETIME_SECONDS,
  WEB_SESSION_COMMAND_PATHS,
  webSessionAccessReplySchema,
  type PresentedWebSession,
} from '@boardsesh/auth-protocol';
import { authCredentialLineage, authSession, authSubjectCutoffs } from '@boardsesh/db/schema';
import {
  accessTokenSecret,
  bridge,
  canonical,
  climber,
  command,
  harnessDatabase,
  legacyCookie,
  login,
  moveGeneration,
  nextAuthSecret,
  post,
  projectionId,
  rows,
  startHarness,
  stopHarness,
  stubCommandEnvironment,
} from './web-session-http-harness';
import { AuthCredentialRefusedError } from '../../human-admission';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { denyFirstPartySession } from '../lineage';
import { replaceCanonicalAfterSecurityMutation } from '../security-session';
import { readFirstPartySession } from '../session-reader';
import { validateToken, type AuthResult } from '../../../middleware/auth';

vi.mock('../../admission-pool', async () => {
  const { harnessDatabase: database } = await import('./web-session-http-harness');
  return {
    readOnAdmissionConnection: async (
      mark: () => void,
      read: (handle: ReturnType<typeof database>) => PromiseLike<unknown>,
    ) => {
      mark();
      return read(database());
    },
  };
});
// The middleware's controller lookup imports the shared client; point it at this suite's database.
vi.mock('../../../db/client', async () => {
  const { harnessDatabase: database } = await import('./web-session-http-harness');
  return {
    db: new Proxy(
      {},
      {
        get: (_target, property) => {
          const member: unknown = Reflect.get(database(), property);
          return typeof member === 'function'
            ? (...parameters: unknown[]) => Reflect.apply(member, database(), parameters)
            : member;
        },
      },
    ),
  };
});

beforeAll(() => startHarness());
beforeEach(stubCommandEnvironment);
afterAll(stopHarness);

const DAY_MS = 86_400_000;

async function access(presented: PresentedWebSession) {
  const { status, body } = await post(WEB_SESSION_COMMAND_PATHS.access, command('access', { presented }));
  const reply = webSessionAccessReplySchema.parse(body);
  expect(status).toBe(reply.outcome === 'active' ? 200 : reply.outcome === 'unauthenticated' ? 401 : 503);
  return reply;
}

async function accessToken(cookieToken: string) {
  const reply = await access(canonical(cookieToken));
  if (reply.outcome !== 'active') throw new Error(`Access answered ${reply.outcome}`);
  return reply.accessToken;
}

/** Admitted: the result. Refused: `refused`. Never anonymous for a browser token. */
async function admit(token: string): Promise<AuthResult | 'refused'> {
  try {
    const result = await validateToken(token, { throwOnRefusal: true });
    if (!result) throw new Error('A browser token must never read as anonymous');
    return result;
  } catch (error) {
    if (error instanceof AuthCredentialRefusedError) return 'refused';
    throw error;
  }
}

describe('the access command', () => {
  it('rolls a session once fewer than 29 days remain, and signs a 15-minute token after reading it again', async () => {
    const { email } = await climber();
    const session = await login(email);
    const fresh = await access(canonical(session.token));
    if (fresh.outcome !== 'active') throw new Error('Fresh session refused');
    expect(fresh).toMatchObject({ rolled: false, authSessionId: session.sessionId, expiresAt: session.expiresAt });
    const tokenLifetime = Date.parse(fresh.accessTokenExpiresAt) - Date.now();
    expect(tokenLifetime).toBeGreaterThan((BROWSER_ACCESS_TOKEN_LIFETIME_SECONDS - 5) * 1000);
    expect(tokenLifetime).toBeLessThanOrEqual(BROWSER_ACCESS_TOKEN_LIFETIME_SECONDS * 1000);
    await harnessDatabase()
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() + 2 * DAY_MS) })
      .where(eq(authSession.id, session.sessionId));
    const due = await access(canonical(session.token));
    if (due.outcome !== 'active') throw new Error('Due session refused');
    expect(due.rolled).toBe(true);
    expect(Date.parse(due.expiresAt)).toBeGreaterThan(Date.now() + 29 * DAY_MS);
    const again = await access(canonical(session.token));
    expect(again).toMatchObject({ outcome: 'active', rolled: false, expiresAt: due.expiresAt });
  });

  it('asks for a bridge for a legacy cookie and reads nothing, and answers no_session for a dead cookie', async () => {
    const { id, email } = await climber();
    const before = await rows(id);
    const legacy = await legacyCookie(id, { claims: { authSessionId: randomUUID() } });
    expect(await access({ kind: 'legacy-jwe', credential: legacy })).toMatchObject({
      outcome: 'unauthenticated',
      reason: 'bridge_required',
    });
    expect(await rows(id)).toEqual(before);
    const session = await login(email);
    await post(
      WEB_SESSION_COMMAND_PATHS.signout,
      command('signout', { token: session.token, expectedUserId: id, expectedAuthSessionId: session.sessionId }),
    );
    expect(await access(canonical(session.token))).toMatchObject({ outcome: 'unauthenticated', reason: 'no_session' });
  });

  it('answers 503 without a usable signing secret', async () => {
    const { email } = await climber();
    const session = await login(email);
    for (const content of [undefined, 'short', nextAuthSecret]) {
      stubCommandEnvironment();
      vi.stubEnv('AUTH_BROWSER_ACCESS_TOKEN_SECRET', content);
      expect(await access(canonical(session.token)), String(content)).toMatchObject({
        outcome: 'error',
        code: 'unavailable',
      });
    }
  });
});

describe('a browser access token on a request', () => {
  it('authenticates a live session, with the session expiry for leases', async () => {
    const { id, email } = await climber();
    const session = await login(email);
    const result = await admit(await accessToken(session.token));
    if (result === 'refused') throw new Error('Live session refused');
    expect(result).toMatchObject({
      userId: id,
      credentialExpiresAt: Date.parse(session.expiresAt),
      credential: { kind: 'web-session', generationClaim: 0, sessionKeyClaim: session.sessionId },
      browserSession: { sessionId: session.sessionId, generation: 0 },
    });
  });

  it('is refused at once by every path that ends its session', async () => {
    const paths: Record<
      string,
      (context: { id: string; email: string; cookie: string; sessionId: string }) => Promise<void>
    > = {
      'sign-out': async ({ id, cookie, sessionId }) => {
        await post(
          WEB_SESSION_COMMAND_PATHS.signout,
          command('signout', { token: cookie, expectedUserId: id, expectedAuthSessionId: sessionId }),
        );
      },
      'a login as another climber presenting it': async ({ cookie }) => {
        const other = await climber();
        await login(other.email, canonical(cookie));
      },
      'a password reset': async ({ id }) => moveGeneration(id, 1),
      'account deletion': async ({ id }) => moveGeneration(id, 0, new Date()),
      'a no-SID cutoff elsewhere': async ({ id }) => {
        const noSid = await readFirstPartySession(harnessDatabase(), {
          kind: 'legacy-jwe',
          credential: await legacyCookie(id),
          secret: nextAuthSecret,
        });
        if (noSid.status !== 'admitted') throw new Error('No-SID cookie refused');
        await denyFirstPartySession(harnessDatabase(), noSid.session, new Date(), {
          expectedProjectionId: projectionId,
          expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
          expectedWriterEpoch: 1,
        });
      },
      'session expiry': async ({ sessionId }) => {
        await harnessDatabase()
          .update(authSession)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(authSession.id, sessionId));
      },
    };
    for (const [label, end] of Object.entries(paths)) {
      const { id, email } = await climber();
      const session = await login(email);
      const token = await accessToken(session.token);
      expect(await admit(token), label).not.toBe('refused');
      await end({ id, email, cookie: session.token, sessionId: session.sessionId });
      expect(await admit(token), label).toBe('refused');
      expect(await validateToken(token), label).toBeNull();
    }
  });

  it('is refused once its bridged session loses its lineage', async () => {
    const { id } = await climber();
    const reply = await bridge(await legacyCookie(id, { claims: { authSessionId: randomUUID() } }));
    if (reply.outcome !== 'bridged') throw new Error('Synthetic bridge refused');
    const token = await accessToken(reply.token);
    expect(await admit(token)).not.toBe('refused');
    await harnessDatabase()
      .update(authCredentialLineage)
      .set({ revokedAt: new Date() })
      .where(eq(authCredentialLineage.userId, id));
    expect(await admit(token)).toBe('refused');
  });

  it('is refused after set-password rotates its session; the rotated cookie gets a new token', async () => {
    const { id, email } = await climber();
    const session = await login(email);
    const token = await accessToken(session.token);
    const actor = await readFirstPartySession(harnessDatabase(), { kind: 'canonical-token', token: session.token });
    if (actor.status !== 'admitted') throw new Error('Session refused');
    const rotated = await harnessDatabase().transaction(async (transaction) => {
      await transaction
        .insert(authSubjectCutoffs)
        .values({ userId: id, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
      return replaceCanonicalAfterSecurityMutation(transaction, actor.session, 1);
    });
    if (!rotated) throw new Error('Session not rotated');
    expect(await admit(token)).toBe('refused');
    const next = await admit(await accessToken(rotated.token));
    expect(next !== 'refused' && next.browserSession).toEqual({ sessionId: session.sessionId, generation: 1 });
  });

  it('proves a recent sign-in only for a login session under five minutes old', async () => {
    const { id, email } = await climber();
    const session = await login(email);
    const recent = (result: AuthResult | 'refused') =>
      result !== 'refused' &&
      result.webSignIn?.authenticatedAtMs !== null &&
      result.webSignIn?.authenticatedAtMs !== undefined &&
      isSignInGoodForPartnerAppChange(
        {
          authTimeSeconds: Math.floor(result.webSignIn.authenticatedAtMs / 1000),
          linkGuarded: result.webSignIn.linkGuarded,
          passwordChangedAt: null,
        },
        Date.now(),
      );
    expect(recent(await admit(await accessToken(session.token)))).toBe(true);
    await harnessDatabase()
      .update(authSession)
      .set({ originalAuthenticatedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(authSession.id, session.sessionId));
    expect(recent(await admit(await accessToken(session.token)))).toBe(false);
    const signedInAt = Math.floor(Date.now() / 1000) - 15;
    const bridged = await bridge(
      await legacyCookie(id, { claims: { authSessionId: randomUUID(), auth_time: signedInAt, link_guarded: true } }),
    );
    if (bridged.outcome !== 'bridged') throw new Error('Synthetic bridge refused');
    const bridgedResult = await admit(await accessToken(bridged.token));
    expect(bridgedResult !== 'refused' && bridgedResult.webSignIn).toEqual({
      authenticatedAtMs: null,
      linkGuarded: true,
    });
  });

  it('refuses a token that claims the browser audience but does not verify', async () => {
    const { email } = await climber();
    const token = await accessToken((await login(email)).token);
    const [header, payload] = token.split('.');
    const issuedAt = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({ sid: 'any', gen: 0 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('any')
      .setIssuer('boardsesh')
      .setAudience('boardsesh-browser')
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 600)
      .sign(new TextEncoder().encode(accessTokenSecret));
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${payload}.`;
    for (const [label, candidate] of Object.entries({
      // Another account in a readable payload; a payload that does not decode claims no audience at all.
      tampered: `${header}.${Buffer.from(
        JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), sub: 'someone-else' }),
      ).toString('base64url')}.${token.split('.')[2]}`,
      'the raw secret instead of the derived key': forged,
      'alg none': unsigned,
    }))
      expect(await admit(candidate), label).toBe('refused');
  });

  it('stays dark while the web session mode is off, and leaves the app token alone', async () => {
    const { id, email } = await climber();
    const token = await accessToken((await login(email)).token);
    const appToken = await new SignJWT({ gen: 0, ngen: 0 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(id)
      .setIssuer('boardsesh')
      .setAudience('boardsesh-mobile')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(nextAuthSecret));
    const cookie = await legacyCookie(id, { claims: { authSessionId: randomUUID() } });
    for (const mode of ['backend-staging', 'legacy', undefined]) {
      vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', mode);
      expect((await validateToken(appToken, { throwOnRefusal: true }))?.credential.kind).toBe('native-access');
      expect((await validateToken(cookie, { throwOnRefusal: true }))?.credential.kind).toBe('web-session');
      expect((await validateToken(cookie))?.browserSession).toBeUndefined();
    }
    for (const mode of ['legacy', undefined, 'not-a-mode']) {
      vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', mode);
      // Off, it takes the app path as before B3a, and fails that path's audience check.
      expect(await validateToken(token, { throwOnRefusal: true })).toBeNull();
    }
  });
});
