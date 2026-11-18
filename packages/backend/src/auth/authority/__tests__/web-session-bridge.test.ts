/**
 * #7596 B2a over real HTTP and PostgreSQL: the private bridge command turns a
 * legacy NextAuth cookie into a backend session whose token is derived from
 * its session id, so the same cookie always gets the same token and one row.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  WEB_SESSION_COMMAND_PATHS,
  webSessionAccessReplySchema,
  webSessionBridgeReplySchema,
  webSessionReadReplySchema,
  webSessionSignOutReplySchema,
} from '@boardsesh/auth-protocol';
import { authSession } from '@boardsesh/db/schema';
import {
  bridge,
  bridgeSecret,
  canonical,
  climber,
  command,
  harnessDatabase,
  legacyCookie,
  moveGeneration,
  nextAuthSecret,
  post,
  rows,
  rpcSecret,
  startHarness,
  stopHarness,
  stubCommandEnvironment,
} from './web-session-http-harness';
import { readFirstPartySession, requireFreshAuthentication, webSignInProof } from '../session-reader';
import { bridgedSessionToken, bridgeTokenKey, sessionTokenDigest } from '../session-token';

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

const read = (token: string) =>
  post(WEB_SESSION_COMMAND_PATHS.session, command('session', { presented: canonical(token) }));

async function bridged(credential: string) {
  const reply = await bridge(credential);
  if (reply.outcome !== 'bridged') throw new Error(`Synthetic bridge answered ${reply.outcome}`);
  return reply;
}

describe('the bridge command', () => {
  it('bridges every legacy cookie shape the backend receives, keeping the session id', async () => {
    const now = Math.floor(Date.now() / 1000);
    const shapes = [
      { label: 'session id and stamp', claims: (sid: string) => ({ authSessionId: sid, gen: 0 }), keepsId: true },
      { label: 'session id, no stamp', claims: (sid: string) => ({ authSessionId: sid }), keepsId: true },
      {
        label: 'a fresh, link-guarded sign-in',
        claims: (sid: string) => ({ authSessionId: sid, gen: 0, auth_time: now - 15, link_guarded: true }),
        keepsId: true,
      },
      {
        label: 'joined from several chunks',
        claims: (sid: string) => ({
          authSessionId: sid,
          gen: 0,
          picture: `https://cdn.example.test/${'a'.repeat(6000)}`,
        }),
        keepsId: true,
      },
      {
        label: 'session id marked legacy_no_sid',
        claims: (sid: string) => ({ authSessionId: sid, legacy_no_sid: true }),
        keepsId: true,
      },
      { label: 'no session id', claims: () => ({ gen: 0 }), keepsId: false },
    ];
    for (const shape of shapes) {
      const { id } = await climber();
      const sessionId = randomUUID();
      const credential = await legacyCookie(id, { claims: shape.claims(sessionId) });
      if (shape.label === 'joined from several chunks') expect(credential.length).toBeGreaterThan(4096);
      const reply = await bridged(credential);
      expect(reply, shape.label).toMatchObject({ userId: id, generation: 0 });
      expect(reply.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      if (shape.keepsId) expect(reply.sessionId).toBe(sessionId);
      // A cookie without its own id is keyed by its lineage, as the bridge always has.
      else expect(reply.sessionId).toMatch(/^credential:[0-9a-f]{64}$/);
      const [row] = await harnessDatabase().select().from(authSession).where(eq(authSession.id, reply.sessionId));
      expect(row.token).toBe(sessionTokenDigest(reply.token));
      expect(row.token).not.toBe(reply.token);
      const session = await read(reply.token);
      expect(session.status, shape.label).toBe(200);
      expect(webSessionReadReplySchema.parse(session.body)).toMatchObject({
        outcome: 'active',
        userId: id,
        authSessionId: reply.sessionId,
        source: 'bridge',
      });
      expect((await rows(id)).cutoffs).toEqual([]);
    }
  });

  it('answers the same token for the same cookie and keeps one row', async () => {
    const { id } = await climber();
    const sessionId = randomUUID();
    const credential = await legacyCookie(id, { claims: { authSessionId: sessionId } });
    const first = await bridged(credential);
    const before = await rows(id);
    const again = await bridged(credential);
    expect(again).toMatchObject({ sessionId, token: first.token, expiresAt: first.expiresAt });
    expect(await rows(id)).toEqual(before);
    expect(before.sessions).toHaveLength(1);
    // The token is the HMAC of the session id under the key derived from AUTH_BRIDGE_TOKEN_SECRET.
    expect(first.token).toBe(bridgedSessionToken(bridgeTokenKey(bridgeSecret), sessionId).token);
    // A renewed copy of the same login is the same session and the same token.
    const renewed = await legacyCookie(id, { claims: { authSessionId: sessionId }, lifetimeSeconds: 7200 });
    expect(await bridged(renewed)).toMatchObject({ sessionId, token: first.token });
    expect((await rows(id)).sessions).toHaveLength(1);
  });

  it('gives two concurrent bridges of one login the same usable token and one row', async () => {
    const { id } = await climber();
    const credential = await legacyCookie(id, { claims: { authSessionId: randomUUID() } });
    const replies = await Promise.all([bridge(credential), bridge(credential)]);
    expect(replies.map((reply) => reply.outcome)).toEqual(['bridged', 'bridged']);
    const [first, second] = replies;
    if (first.outcome !== 'bridged' || second.outcome !== 'bridged') throw new Error('Unreachable');
    expect(second.token).toBe(first.token);
    expect((await rows(id)).sessions).toHaveLength(1);
    expect((await read(first.token)).status).toBe(200);
  });

  it('denies a moved, missing or zero stamp, an expired, forged or deleted cookie, and writes nothing', async () => {
    const cases: { label: string; credential: string; userId: string }[] = [];
    const moved = await climber();
    await moveGeneration(moved.id, 2);
    for (const claims of [{ gen: 1 }, {}, { gen: 0 }, { gen: 3 }])
      cases.push({
        label: `stamp ${JSON.stringify(claims)} on generation 2`,
        userId: moved.id,
        credential: await legacyCookie(moved.id, { claims: { ...claims, authSessionId: randomUUID() } }),
      });
    const noSid = await climber();
    await moveGeneration(noSid.id, 1);
    cases.push({ label: 'no-SID on generation 1', userId: noSid.id, credential: await legacyCookie(noSid.id) });
    const expired = await climber();
    cases.push({
      label: 'expired',
      userId: expired.id,
      credential: await legacyCookie(expired.id, {
        claims: { authSessionId: randomUUID() },
        issuedAtSeconds: Math.floor(Date.now() / 1000) - 7200,
      }),
    });
    const forged = await climber();
    cases.push({
      label: 'another secret',
      userId: forged.id,
      credential: await legacyCookie(forged.id, {
        claims: { authSessionId: randomUUID() },
        secret: 'an-attacker-chosen-nextauth-secret-value',
      }),
    });
    const deleted = await climber();
    await moveGeneration(deleted.id, 0, new Date());
    cases.push({
      label: 'deleted account',
      userId: deleted.id,
      credential: await legacyCookie(deleted.id, { claims: { authSessionId: randomUUID() } }),
    });
    const missing = randomUUID();
    cases.push({
      label: 'missing account',
      userId: missing,
      credential: await legacyCookie(missing, { claims: { authSessionId: randomUUID() } }),
    });
    for (const { label, credential, userId } of cases) {
      const before = await rows(userId);
      expect((await bridge(credential)).outcome, label).toBe('denied');
      expect(await rows(userId), label).toEqual(before);
    }
    // The current stamp on the moved account still bridges.
    const current = await legacyCookie(moved.id, { claims: { gen: 2, authSessionId: randomUUID() } });
    expect((await bridged(current)).generation).toBe(2);
  });

  it('keeps a bridged session out of every five-minute check, with its sign-in time for the 30-day rules', async () => {
    const { id } = await climber();
    const signedInAt = Math.floor(Date.now() / 1000) - 15;
    const credential = await legacyCookie(id, {
      claims: { authSessionId: randomUUID(), auth_time: signedInAt, link_guarded: true },
    });
    // Read directly, the legacy cookie is the fresh login itself.
    const legacy = await readFirstPartySession(harnessDatabase(), {
      kind: 'legacy-jwe',
      credential,
      secret: nextAuthSecret,
    });
    if (legacy.status !== 'admitted') throw new Error('Synthetic cookie refused');
    expect(requireFreshAuthentication(legacy.session)).toBe(true);
    const reply = await bridged(credential);
    const session = await readFirstPartySession(harnessDatabase(), { kind: 'canonical-token', token: reply.token });
    if (session.status !== 'admitted') throw new Error('Bridged token refused');
    expect(session.session.source).toBe('bridge');
    expect(session.session.authenticatedAt?.getTime()).toBe(signedInAt * 1000);
    // Set-password, the developer console and webSignIn all go through these two.
    expect(requireFreshAuthentication(session.session)).toBe(false);
    expect(webSignInProof(session.session)).toEqual({ authenticatedAtMs: null, linkGuarded: true });
    expect(webSessionReadReplySchema.parse((await read(reply.token)).body)).toMatchObject({
      source: 'bridge',
      authenticatedAt: new Date(signedInAt * 1000).toISOString(),
    });
  });

  it('rolls a bridged row past the legacy expiry, and a later bridge never shortens it', async () => {
    const { id } = await climber();
    const credential = await legacyCookie(id, { claims: { authSessionId: randomUUID() } });
    const reply = await bridged(credential);
    const legacyExpiry = new Date(reply.expiresAt).getTime();
    expect(legacyExpiry).toBeLessThan(Date.now() + 2 * 3_600_000);
    const roll = await post(WEB_SESSION_COMMAND_PATHS.access, command('access', { presented: canonical(reply.token) }));
    const rolled = webSessionAccessReplySchema.parse(roll.body);
    if (rolled.outcome !== 'active') throw new Error('Bridged roll refused');
    expect(rolled.rolled).toBe(true);
    expect(new Date(rolled.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    const again = await bridged(credential);
    expect(again.token).toBe(reply.token);
    expect(again.expiresAt).toBe(rolled.expiresAt);
  });

  it('denies a cookie whose session id is a login or carried row, and writes nothing', async () => {
    for (const lineage of [null, 'carried:']) {
      const { id } = await climber();
      const sessionId = randomUUID();
      await harnessDatabase()
        .insert(authSession)
        .values({
          id: sessionId,
          token: sessionTokenDigest(randomUUID()),
          userId: id,
          expiresAt: new Date(Date.now() + 86_400_000),
          updatedAt: new Date(),
          originalAuthenticatedAt: new Date(),
          legacyLineageId: lineage && `${lineage}${sessionId}`,
          revocationGeneration: 0,
        });
      const before = await rows(id);
      // The rollback cookie a post-cutover login writes carries the login's session id.
      const credential = await legacyCookie(id, { claims: { authSessionId: sessionId, gen: 0 } });
      expect((await bridge(credential)).outcome, String(lineage)).toBe('denied');
      expect(await rows(id)).toEqual(before);
    }
  });

  it('denies a bridged row whose token the current key does not derive, and leaves it readable', async () => {
    const { id } = await climber();
    const credential = await legacyCookie(id, { claims: { authSessionId: randomUUID() } });
    const reply = await bridged(credential);
    vi.stubEnv('AUTH_BRIDGE_TOKEN_SECRET', 'a-rotated-synthetic-bridge-token-secret-6975');
    const before = await rows(id);
    expect((await bridge(credential)).outcome).toBe('denied');
    expect(await rows(id)).toEqual(before);
    expect((await read(reply.token)).status).toBe(200);
  });
});

describe('the bridge command switches', () => {
  it('answers 503, never a denial, without a usable bridge secret or NEXTAUTH_SECRET', async () => {
    const { id } = await climber();
    const credential = await legacyCookie(id, { claims: { authSessionId: randomUUID() } });
    for (const [name, content] of [
      ['AUTH_BRIDGE_TOKEN_SECRET', undefined],
      ['AUTH_BRIDGE_TOKEN_SECRET', 'too-short'],
      ['AUTH_BRIDGE_TOKEN_SECRET', ` ${bridgeSecret}`],
      ['AUTH_BRIDGE_TOKEN_SECRET', rpcSecret],
      ['AUTH_BRIDGE_TOKEN_SECRET', nextAuthSecret],
      ['NEXTAUTH_SECRET', ''],
    ] as const) {
      stubCommandEnvironment();
      vi.stubEnv(name, content);
      const reply = await bridge(credential);
      expect(reply, `${name}=${String(content)}`).toMatchObject({ outcome: 'error', code: 'unavailable' });
    }
    expect((await rows(id)).sessions).toEqual([]);
  });

  it('ends at AUTH_LEGACY_BRIDGE_UNTIL: denied after it with nothing written, bridged before it, 503 unset or invalid', async () => {
    const { id } = await climber();
    const credential = await legacyCookie(id, { claims: { authSessionId: randomUUID() } });
    vi.stubEnv('AUTH_LEGACY_BRIDGE_UNTIL', new Date(Date.now() - 1000).toISOString());
    expect(await bridge(credential)).toMatchObject({ outcome: 'denied' });
    expect((await rows(id)).sessions).toEqual([]);
    // Unset, or not an exact time with an offset: 503, never an open-ended bridge and never a denial.
    for (const invalid of [
      undefined,
      'next month',
      '2027-02-30T00:00:00Z',
      '2027-01-01T24:00:00Z',
      '2027-01-01T00:00:00',
    ]) {
      vi.stubEnv('AUTH_LEGACY_BRIDGE_UNTIL', invalid);
      expect(await bridge(credential), String(invalid)).toMatchObject({ outcome: 'error', code: 'unavailable' });
    }
    expect((await rows(id)).sessions).toEqual([]);
    vi.stubEnv('AUTH_LEGACY_BRIDGE_UNTIL', new Date(Date.now() + 86_400_000).toISOString());
    expect(await bridge(credential)).toMatchObject({ outcome: 'bridged' });
  });

  it('answers 404 while the web session mode is off, whatever the native bridge switch says', async () => {
    const { id } = await climber();
    const credential = await legacyCookie(id, { claims: { authSessionId: randomUUID() } });
    for (const mode of [undefined, '', 'legacy']) {
      vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', mode);
      vi.stubEnv('AUTH_LEGACY_BRIDGE_MODE', 'on');
      expect(await post(WEB_SESSION_COMMAND_PATHS.bridge, command('bridge', { credential }))).toEqual({
        status: 404,
        body: { error: 'disabled' },
      });
    }
    expect((await rows(id)).sessions).toEqual([]);
  });

  it('answers a wrong secret with a 401 no command reply parses, for every command', async () => {
    const schemas = {
      session: webSessionReadReplySchema,
      signout: webSessionSignOutReplySchema,
      bridge: webSessionBridgeReplySchema,
      access: webSessionAccessReplySchema,
    } as const;
    const payloads = {
      session: { presented: canonical('t') },
      signout: { token: 't', expectedUserId: 'u', expectedAuthSessionId: 's' },
      bridge: { credential: 'a.b.c.d.e' },
      access: { presented: canonical('t') },
    } as const;
    for (const operation of Object.keys(schemas) as (keyof typeof schemas)[]) {
      for (const authorization of ['Bearer wrong-secret-of-the-wrong-length', `Bearer ${rpcSecret}x`, '']) {
        const response = await post(
          WEB_SESSION_COMMAND_PATHS[operation],
          command(operation, payloads[operation]),
          authorization,
        );
        expect(response, operation).toEqual({ status: 401, body: { error: 'unauthorized' } });
        expect(schemas[operation].safeParse(response.body).success, operation).toBe(false);
      }
    }
  });
});
