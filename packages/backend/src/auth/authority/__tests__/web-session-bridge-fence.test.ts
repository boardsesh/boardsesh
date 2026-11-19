/**
 * #7596 B2a review over real HTTP and PostgreSQL: what stands in front of the
 * bridge (the authority manifest and the commands' lock timeout), and the
 * identity of a no-SID cookie, which must not depend on how its bytes are spelt.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { WEB_SESSION_COMMAND_PATHS } from '@boardsesh/auth-protocol';
import { authEmailProjection, authSession, users } from '@boardsesh/db/schema';
import {
  bridge,
  canonical,
  climber,
  command,
  harnessDatabase,
  legacyCookie,
  post,
  rows,
  startHarness,
  stopHarness,
  stubCommandEnvironment,
} from './web-session-http-harness';
import { WEB_SESSION_LIFETIME_SECONDS } from '../web-session';

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

beforeAll(() => startHarness());
beforeEach(stubCommandEnvironment);
afterAll(stopHarness);

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function bridged(credential: string) {
  const reply = await bridge(credential);
  if (reply.outcome !== 'bridged') throw new Error(`Synthetic bridge answered ${reply.outcome}`);
  return reply;
}

/** Re-encodings of one compact JWE that the decoder still reads as the same bytes. */
function byteVariants(credential: string): string[] {
  const segments = credential.split('.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const tag = segments[4];
  const ciphertext = segments[3];
  const middle = Math.floor(ciphertext.length / 2);
  const withSegment = (index: number, value: string) =>
    segments.map((part, at) => (at === index ? value : part)).join('.');
  return [
    withSegment(4, `${tag.slice(0, -1)}${alphabet[alphabet.indexOf(tag.slice(-1)) ^ 1]}`),
    withSegment(4, `${tag}==`),
    withSegment(3, `${ciphertext.slice(0, middle)} ${ciphertext.slice(middle)}`),
    `${credential}\n`,
  ];
}

describe('the authority in front of the bridge', () => {
  it('answers 503 and writes nothing unless the manifest is enforced for this projection and epoch', async () => {
    const { id } = await climber();
    const credential = await legacyCookie(id, { claims: { authSessionId: randomUUID() } });
    const [manifest] = await harnessDatabase().select().from(authEmailProjection);
    try {
      await harnessDatabase().update(authEmailProjection).set({ phase: 'prepared' });
      expect(await bridge(credential)).toMatchObject({ outcome: 'error', code: 'unavailable' });
    } finally {
      await harnessDatabase().update(authEmailProjection).set({ phase: manifest.phase });
    }
    vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', String(manifest.writerEpoch + 1));
    expect(await bridge(credential)).toMatchObject({ outcome: 'error', code: 'unavailable' });
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', 'another-projection');
    expect(await bridge(credential)).toMatchObject({ outcome: 'error', code: 'unavailable' });
    expect((await rows(id)).sessions).toEqual([]);
    stubCommandEnvironment();
    expect((await bridged(credential)).userId).toBe(id);
  });

  it('gives up with 503 when the account stays locked past the lock timeout', async () => {
    const { id } = await climber();
    const credential = await legacyCookie(id, { claims: { authSessionId: randomUUID() } });
    const startedAt = Date.now();
    const reply = await harnessDatabase().transaction(async (transaction) => {
      // A password reset or deletion holds the account like this.
      await transaction.select({ id: users.id }).from(users).where(eq(users.id, id)).for('update');
      return bridge(credential);
    });
    expect(reply).toMatchObject({ outcome: 'error', code: 'unavailable' });
    expect(Date.now() - startedAt).toBeLessThan(8000);
    expect((await rows(id)).sessions).toEqual([]);
  }, 20_000);

  it('never shortens a row that a roll extended while a bridge was renewing it', async () => {
    const { id } = await climber();
    const sessionId = randomUUID();
    const first = await bridged(await legacyCookie(id, { claims: { authSessionId: sessionId } }));
    const renewed = await legacyCookie(id, { claims: { authSessionId: sessionId }, lifetimeSeconds: 7200 });
    const rolledTo = new Date(Date.now() + WEB_SESSION_LIFETIME_SECONDS * 1000);
    let renewing: ReturnType<typeof bridge> | undefined;
    await harnessDatabase().transaction(async (transaction) => {
      // Hold the row, let the bridge read the old expiry and queue its renewal, then roll and commit.
      await transaction.execute(sql`SELECT 1 FROM auth_session WHERE id = ${sessionId} FOR UPDATE`);
      renewing = bridge(renewed);
      await pause(500);
      await transaction.update(authSession).set({ expiresAt: rolledTo }).where(eq(authSession.id, sessionId));
    });
    if (!renewing) throw new Error('Bridge not started');
    const reply = await renewing;
    expect(reply).toMatchObject({ outcome: 'bridged', expiresAt: rolledTo.toISOString() });
    const [row] = await harnessDatabase().select().from(authSession).where(eq(authSession.id, sessionId));
    expect(row.expiresAt.getTime()).toBe(rolledTo.getTime());
    expect(await bridged(renewed)).toMatchObject({ token: first.token, expiresAt: rolledTo.toISOString() });
  }, 20_000);
});

describe('a cookie without a session id', () => {
  it('is one session whatever the spelling of its bytes, and its sign-out ends every spelling', async () => {
    const { id } = await climber();
    const cookie = await legacyCookie(id, { claims: { gen: 0 } });
    const original = await bridged(cookie);
    for (const variant of byteVariants(cookie)) {
      expect(variant).not.toBe(cookie);
      expect(await bridged(variant)).toMatchObject({ sessionId: original.sessionId, token: original.token });
    }
    expect((await rows(id)).sessions).toHaveLength(1);
    const signedOut = await post(
      WEB_SESSION_COMMAND_PATHS.signout,
      command('signout', {
        presented: { kind: 'legacy-jwe', credential: cookie },
        expectedUserId: id,
        expectedAuthSessionId: original.sessionId,
      }),
    );
    expect(signedOut.status).toBe(200);
    for (const variant of [cookie, ...byteVariants(cookie)]) expect((await bridge(variant)).outcome).toBe('denied');
    const read = await post(
      WEB_SESSION_COMMAND_PATHS.session,
      command('session', { presented: canonical(original.token) }),
    );
    expect(read.status).toBe(401);
    expect((await rows(id)).cutoffs).toEqual([]);
  });
});
