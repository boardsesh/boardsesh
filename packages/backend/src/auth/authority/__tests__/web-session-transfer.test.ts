/**
 * #7596 B4c over real HTTP and PostgreSQL: a native OAuth transfer token signs
 * a browser in with a `carried` web session that keeps the native sign-in's
 * time, is never fresh, spends the token once and revokes the session the
 * browser presented.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  WEB_SESSION_COMMAND_PATHS,
  webSessionReadReplySchema,
  webSessionTransferReplySchema,
  type PresentedWebSession,
} from '@boardsesh/auth-protocol';
import { authSession, authSessionDenials, verificationTokens } from '@boardsesh/db/schema';
import {
  canonical,
  climber,
  command,
  harnessDatabase,
  login,
  moveGeneration,
  nextAuthSecret,
  post,
  rows,
  startHarness,
  stopHarness,
  stubCommandEnvironment,
} from './web-session-http-harness';
import { readFirstPartySession, requireFreshAuthentication } from '../session-reader';

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

/** A transfer token as www's native callback signs it (`native-oauth-transfer.ts`). */
function transferToken(
  userId: string,
  claims: { gen?: number; authTime?: number | null; authSessionId?: string; ageSeconds?: number; secret?: string } = {},
) {
  const issuedAt = Math.floor(Date.now() / 1000) - (claims.ageSeconds ?? 0);
  const payload = {
    userId,
    nextPath: '/',
    iat: issuedAt,
    exp: issuedAt + 120,
    gen: claims.gen ?? 0,
    authSessionId: claims.authSessionId ?? randomUUID(),
    ...(claims.authTime === null ? {} : { auth_time: claims.authTime ?? issuedAt - 30, link_guarded: true }),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', claims.secret ?? nextAuthSecret)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

async function transfer(token: string, presented?: PresentedWebSession) {
  const { status, body } = await post(
    WEB_SESSION_COMMAND_PATHS.transfer,
    command('transfer', { transferToken: token, ...(presented ? { presented } : {}) }),
  );
  const reply = webSessionTransferReplySchema.parse(body);
  expect(status).toBe(reply.outcome === 'issued' ? 200 : reply.outcome === 'error' ? 503 : 401);
  return reply;
}

async function issued(token: string, presented?: PresentedWebSession) {
  const reply = await transfer(token, presented);
  if (reply.outcome !== 'issued') throw new Error(`Transfer answered ${reply.outcome}`);
  return reply;
}

const readStatus = async (token: string) =>
  (await post(WEB_SESSION_COMMAND_PATHS.session, command('session', { presented: canonical(token) }))).status;

const spentTransfers = () =>
  harnessDatabase().select().from(verificationTokens).where(like(verificationTokens.identifier, 'native-transfer:%'));

describe('the transfer command', () => {
  it('issues a carried session with the native sign-in time and a proof that is never fresh', async () => {
    const { id } = await climber();
    const signedInAt = Math.floor(Date.now() / 1000) - 20;
    const reply = await issued(transferToken(id, { authTime: signedInAt }));
    expect(reply.credentialProof).toEqual({
      version: 1,
      userId: id,
      authSessionId: reply.webSession.sessionId,
      generation: reply.webSession.generation,
      authenticatedAt: null,
      linkGuarded: false,
    });
    expect(reply.user.id).toBe(id);
    const read = webSessionReadReplySchema.parse(
      (
        await post(
          WEB_SESSION_COMMAND_PATHS.session,
          command('session', { presented: canonical(reply.webSession.token) }),
        )
      ).body,
    );
    expect(read).toMatchObject({
      outcome: 'active',
      userId: id,
      authSessionId: reply.webSession.sessionId,
      source: 'bridge',
      authenticatedAt: new Date(signedInAt * 1000).toISOString(),
    });
    const session = await readFirstPartySession(harnessDatabase(), {
      kind: 'canonical-token',
      token: reply.webSession.token,
    });
    if (session.status !== 'admitted') throw new Error('Transferred session refused');
    // Twenty seconds old, and still not a fresh sign-in.
    expect(requireFreshAuthentication(session.session)).toBe(false);
  });

  it('signs a browser held by another account in as the transferred one, revoking the old session', async () => {
    const [transferred, previous] = [await climber(), await climber()];
    const previousSession = await login(previous.email);
    const reply = await issued(transferToken(transferred.id), canonical(previousSession.token));
    expect(reply.user.id).toBe(transferred.id);
    expect(await readStatus(previousSession.token)).toBe(401);
    expect(await readStatus(reply.webSession.token)).toBe(200);
    expect((await rows(previous.id)).cutoffs).toEqual([]);
  });

  it('crosses with a password login of the other account without deadlock; each revokes what it was shown', async () => {
    const [first, second] = [await climber(), await climber()];
    const [firstSession, secondSession] = [await login(first.email), await login(second.email)];
    const [transferred, loggedIn] = await Promise.all([
      issued(transferToken(first.id), canonical(secondSession.token)),
      login(second.email, canonical(firstSession.token)),
    ]);
    expect(await readStatus(firstSession.token)).toBe(401);
    expect(await readStatus(secondSession.token)).toBe(401);
    expect(await readStatus(transferred.webSession.token)).toBe(200);
    expect(await readStatus(loggedIn.token)).toBe(200);
  });

  it('spends a transfer token once', async () => {
    const { id } = await climber();
    const token = transferToken(id);
    await issued(token);
    const before = await rows(id);
    expect((await transfer(token)).outcome).toBe('denied');
    expect(await rows(id)).toEqual(before);
    expect(before.sessions).toHaveLength(1);
  });

  it('refuses a deleted account, a moved generation, a signed-out source, an expired or forged token, writing nothing', async () => {
    const deleted = await climber();
    await moveGeneration(deleted.id, 0, new Date());
    const moved = await climber();
    await moveGeneration(moved.id, 1);
    const signedOut = await climber();
    const signedOutSource = randomUUID();
    await harnessDatabase()
      .insert(authSessionDenials)
      .values({ sessionId: signedOutSource, userId: signedOut.id, expiresAt: new Date(Date.now() + 86_400_000) });
    const plain = await climber();
    const spentBefore = (await spentTransfers()).length;
    for (const [label, userId, token] of [
      ['deleted account', deleted.id, transferToken(deleted.id)],
      ['moved generation', moved.id, transferToken(moved.id, { gen: 0 })],
      ['signed-out source login', signedOut.id, transferToken(signedOut.id, { authSessionId: signedOutSource })],
      ['expired token', plain.id, transferToken(plain.id, { ageSeconds: 600 })],
      ['another key', plain.id, transferToken(plain.id, { secret: 'an-attacker-chosen-nextauth-secret-0123' })],
    ] as const) {
      const before = await rows(userId);
      expect((await transfer(token)).outcome, label).toBe('denied');
      expect(await rows(userId), label).toEqual(before);
    }
    expect((await spentTransfers()).length).toBe(spentBefore);
  });

  it('sends a transfer with no verified sign-in time to sign in', async () => {
    const { id } = await climber();
    expect((await transfer(transferToken(id, { authTime: null }))).outcome).toBe('sign_in_required');
    expect(await harnessDatabase().select().from(authSession).where(eq(authSession.userId, id))).toEqual([]);
  });

  it('answers 503 without NEXTAUTH_SECRET, and 404 with the mode off', async () => {
    const { id } = await climber();
    const token = transferToken(id);
    vi.stubEnv('NEXTAUTH_SECRET', '');
    expect(await transfer(token)).toMatchObject({ outcome: 'error', code: 'unavailable' });
    stubCommandEnvironment();
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'legacy');
    expect(await post(WEB_SESSION_COMMAND_PATHS.transfer, command('transfer', { transferToken: token }))).toEqual({
      status: 404,
      body: { error: 'disabled' },
    });
  });
});
