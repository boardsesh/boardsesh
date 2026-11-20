/**
 * #7596 B3a review, H1: a burst of browser requests on one replica shares a
 * few admission reads instead of taking one runner slot each, and a native
 * admission in the same burst still gets its read. M1: with the web session
 * mode off, no token is decoded to look for the browser audience.
 */
import { SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { WEB_SESSION_COMMAND_PATHS, webSessionAccessReplySchema } from '@boardsesh/auth-protocol';
import {
  canonical,
  climber,
  command,
  login,
  nextAuthSecret,
  post,
  startHarness,
  stopHarness,
  stubCommandEnvironment,
} from './web-session-http-harness';
import { MAX_UNSETTLED_AUTH_ADMISSION_READS } from '../../admission-read-runner';
import { validateToken } from '../../../middleware/auth';
import * as browserAccessToken from '../browser-access-token';
import { barrier, bounded } from './lock-order-harness';

const statements = vi.hoisted(() => ({ count: 0, delayMs: 0 }));
vi.mock('../../admission-pool', async () => {
  const { harnessDatabase: database } = await import('./web-session-http-harness');
  return {
    readOnAdmissionConnection: async (
      mark: () => void,
      read: (handle: ReturnType<typeof database>) => PromiseLike<unknown>,
    ) => {
      mark();
      statements.count += 1;
      // A slow primary keeps every read in flight while the burst arrives.
      if (statements.delayMs) await new Promise((resolve) => setTimeout(resolve, statements.delayMs));
      return read(database());
    },
  };
});
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
const decodes = vi.hoisted(() => ({ count: 0 }));
vi.mock('../browser-access-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browser-access-token')>();
  return {
    ...actual,
    claimsBrowserAudience: (token: string) => {
      decodes.count += 1;
      return actual.claimsBrowserAudience(token);
    },
  };
});

beforeAll(() => startHarness());
beforeEach(() => {
  stubCommandEnvironment();
  statements.delayMs = 0;
});
afterAll(stopHarness);

async function browserToken(): Promise<{ userId: string; token: string }> {
  const { id, email } = await climber();
  const session = await login(email);
  const reply = webSessionAccessReplySchema.parse(
    (await post(WEB_SESSION_COMMAND_PATHS.access, command('access', { presented: canonical(session.token) }))).body,
  );
  if (reply.outcome !== 'active') throw new Error('No access token');
  return { userId: id, token: reply.accessToken };
}

function appToken(userId: string) {
  return new SignJWT({ gen: 0, ngen: 0 })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('boardsesh')
    .setAudience('boardsesh-mobile')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(nextAuthSecret));
}

describe('a burst of browser requests on one replica', () => {
  it('admits 50 at once with a few reads, and a native request in the same burst', async () => {
    const browsers = await Promise.all(Array.from({ length: 50 }, browserToken));
    const native = await climber();
    const nativeToken = await appToken(native.id);
    statements.count = 0;
    statements.delayMs = 50;
    const results = await Promise.all([
      ...browsers.map(({ token }) => validateToken(token, { throwOnRefusal: true })),
      validateToken(nativeToken, { throwOnRefusal: true }),
    ]);
    expect(results.map((result) => result?.userId)).toEqual([...browsers.map(({ userId }) => userId), native.id]);
    // One read for the sessions, one for the native account, at most a couple more if the burst straddled a tick.
    expect(statements.count).toBeLessThanOrEqual(4);
    expect(statements.count).toBeLessThan(MAX_UNSETTLED_AUTH_ADMISSION_READS);
  });

  it('admits the same session asked nine times at once, as a resubscribe does, with one read', async () => {
    const { userId, token } = await browserToken();
    statements.count = 0;
    const callers = 9;
    const verifiedTogether = barrier();
    const realVerify = browserAccessToken.verifyBrowserAccessToken;
    let verifiedCallers = 0;
    // Crypto can settle across different event-loop turns. Release the real verified tokens
    // together so this case exercises callers arriving before the coalescer claims its batch.
    const verifier = vi.spyOn(browserAccessToken, 'verifyBrowserAccessToken').mockImplementation(async (...args) => {
      const verified = await realVerify(...args);
      if (!verified) throw new Error('The fixture browser token failed verification');
      if (++verifiedCallers === callers) verifiedTogether.resolve();
      await verifiedTogether.promise;
      return verified;
    });
    try {
      const results = await bounded(Promise.all(Array.from({ length: callers }, () => validateToken(token))));
      expect(results.map((result) => result?.userId)).toEqual(Array.from({ length: callers }, () => userId));
      expect(statements.count).toBe(1);
    } finally {
      verifiedTogether.resolve();
      verifier.mockRestore();
    }
  });
});

describe('with the web session mode off', () => {
  it('decodes no token: a browser token takes the app path untouched', async () => {
    const { token } = await browserToken();
    for (const mode of ['legacy', undefined, 'not-a-mode']) {
      vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', mode);
      decodes.count = 0;
      expect(await validateToken(token)).toBeNull();
      expect(decodes.count).toBe(0);
    }
  });
});
