/**
 * #7596 B4c over real HTTP and PostgreSQL: a native OAuth transfer token signs
 * a browser in with a `carried` web session that keeps the native sign-in's
 * time, is never fresh, spends the token once and revokes the session the
 * browser presented.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
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
import { isTokenConsumed, markTokenConsumed } from '../../native-transfer-replay';
import { users } from '@boardsesh/db/schema';

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

/** The durable spent markers of these tokens (command-claim prefix, transfer hash domain). */
const spentRows = (...tokens: string[]) =>
  harnessDatabase()
    .select()
    .from(verificationTokens)
    .where(
      inArray(
        verificationTokens.token,
        tokens.map((token) =>
          createHash('sha256')
            .update(`native-transfer\0${token.split('.')[1]}`)
            .digest('hex'),
        ),
      ),
    );

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
    const tokens: string[] = [];
    for (const [label, userId, token] of [
      ['deleted account', deleted.id, transferToken(deleted.id)],
      ['moved generation', moved.id, transferToken(moved.id, { gen: 0 })],
      ['signed-out source login', signedOut.id, transferToken(signedOut.id, { authSessionId: signedOutSource })],
      ['expired token', plain.id, transferToken(plain.id, { ageSeconds: 600 })],
      ['another key', plain.id, transferToken(plain.id, { secret: 'an-attacker-chosen-nextauth-secret-0123' })],
    ] as const) {
      tokens.push(token);
      const before = await rows(userId);
      expect((await transfer(token)).outcome, label).toBe('denied');
      expect(await rows(userId), label).toEqual(before);
    }
    expect(await spentRows(...tokens)).toEqual([]);
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

  it('refuses every other spelling of a good token, which then still works once', async () => {
    const { id } = await climber();
    const token = transferToken(id);
    const [payload, signature] = token.split('.');
    for (const [label, variant] of [
      ['one trailing NUL', `${token}\u0000`],
      ['two trailing NULs', `${token}\u0000\u0000`],
      ['padding', `${token}=`],
      ['padded payload', `${payload}=.${signature}`],
      ['a space', `${payload}. ${signature}`],
      ['a trailing newline', `${token}\n`],
      ['a third segment', `${token}.x`],
    ] as const) {
      const reply = await post(WEB_SESSION_COMMAND_PATHS.transfer, command('transfer', { transferToken: variant }));
      expect(webSessionTransferReplySchema.parse(reply.body).outcome, label).toBe('denied');
    }
    expect((await rows(id)).sessions).toEqual([]);
    expect((await issued(token)).user.id).toBe(id);
    expect((await transfer(token)).outcome).toBe('denied');
    expect((await rows(id)).sessions).toHaveLength(1);
    expect(await spentRows(token)).toHaveLength(1);
  });

  it('shares one spent marker with the native exchange, in both orders', async () => {
    const { id } = await climber();
    // Redeemed by the app first: the exchange marks the recomputed signature.
    const redeemedNatively = transferToken(id);
    expect(await markTokenConsumed(redeemedNatively.split('.')[1])).toBe('consumed');
    expect((await transfer(redeemedNatively)).outcome).toBe('denied');
    expect((await rows(id)).sessions).toEqual([]);
    // Redeemed here first: the exchange's own check then sees it spent.
    const redeemedHere = transferToken(id);
    await issued(redeemedHere);
    expect(await isTokenConsumed(redeemedHere.split('.')[1])).toBe(true);
    expect(await markTokenConsumed(redeemedHere.split('.')[1])).toBe('replay');
  });

  it('issues one session for one token redeemed twice at once', async () => {
    const { id } = await climber();
    const token = transferToken(id);
    const replies = await Promise.all([transfer(token), transfer(token)]);
    expect(replies.map((reply) => reply.outcome).sort()).toEqual(['denied', 'issued']);
    expect((await rows(id)).sessions).toHaveLength(1);
  });

  it('ends with no live session when a transfer crosses a generation move', async () => {
    const { id } = await climber();
    const [reply] = await Promise.all([
      transfer(transferToken(id)),
      harnessDatabase().transaction(async (transaction) => {
        // A reset holds the account like this while it moves the generation.
        await transaction.select({ id: users.id }).from(users).where(eq(users.id, id)).for('update');
        await new Promise((resolve) => setTimeout(resolve, 100));
        await moveGenerationIn(transaction, id);
      }),
    ]);
    if (reply.outcome === 'issued') expect(await readStatus(reply.webSession.token)).toBe(401);
    else expect(reply.outcome).toBe('denied');
  });

  it('revokes the presented session whichever wins when a transfer crosses its sign-out', async () => {
    const [transferred, previous] = [await climber(), await climber()];
    const previousSession = await login(previous.email);
    const [reply, signedOut] = await Promise.all([
      transfer(transferToken(transferred.id), canonical(previousSession.token)),
      post(
        WEB_SESSION_COMMAND_PATHS.signout,
        command('signout', {
          token: previousSession.token,
          expectedUserId: previous.id,
          expectedAuthSessionId: previousSession.sessionId,
        }),
      ),
    ]);
    expect(signedOut.status).toBe(200);
    expect(await readStatus(previousSession.token)).toBe(401);
    if (reply.outcome !== 'issued') throw new Error(`Transfer answered ${reply.outcome}`);
    expect(await readStatus(reply.webSession.token)).toBe(200);
    expect((await rows(previous.id)).cutoffs).toEqual([]);
  });
});

/** A generation move as a reset writes it, inside the caller's transaction. */
async function moveGenerationIn(
  transaction: Parameters<Parameters<ReturnType<typeof harnessDatabase>['transaction']>[0]>[0],
  userId: string,
) {
  const { authSubjectCutoffs } = await import('@boardsesh/db/schema');
  await transaction
    .insert(authSubjectCutoffs)
    .values({ userId, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
}
