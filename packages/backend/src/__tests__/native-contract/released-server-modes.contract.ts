import { createHash, randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { and, eq, like } from 'drizzle-orm';
import { decodeJwt, exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authAccount,
  authEmailProjection,
  authEmailReservations,
  authSession,
  authSubjectCutoffs,
  mobileRefreshTokens,
  userCredentials,
  users,
} from '@boardsesh/db/schema';
import { NATIVE_V1_PATHS } from '@boardsesh/auth-protocol/native-v1';
import { createNativeHttpFixture } from './http-fixture';
import { parseSync } from 'vite-plus';
import { recordedSource, recordings, type ReleasedClient } from './recordings';
import { callRecorded, createReleasedClient } from './released-client';
import { createReleasedProvider, USER_TABLES } from './released-provider';
import { createG2Watch, createPreG2Watch, type WatchPost } from './garmin-watch';
import {
  MODE_SELECTORS,
  SERVER_MODES,
  expectedStageEvidence,
  reachManifest,
  startupRefusals,
  type ServerMode,
  type StageEvidence,
} from './server-modes';

// Replace only the provider's remote JWKS transport. Signature, issuer,
// audience, nonce, subject resolution and all database writes stay real.
const providerJwks = vi.hoisted(() => ({ keys: [] as JWK[] }));
vi.mock('jose', async (importOriginal) => {
  const original = await importOriginal<typeof import('jose')>();
  return {
    ...original,
    createRemoteJWKSet: (url: URL, options?: Parameters<typeof original.createRemoteJWKSet>[1]) =>
      original.createRemoteJWKSet(url, {
        ...options,
        [original.customFetch]: async () => {
          if (
            !['https://appleid.apple.com/auth/keys', 'https://www.googleapis.com/oauth2/v3/certs'].includes(
              url.toString(),
            )
          )
            throw new Error('Unrecorded provider network refused');
          return Response.json({ keys: providerJwks.keys });
        },
      }),
  };
});

type Client = Awaited<ReturnType<typeof createReleasedClient>>;
interface Pair {
  jwt: string;
  refreshToken: string;
  expiresAt: string;
}
interface Carried {
  phone: Client;
  g2: ReturnType<typeof createG2Watch>;
  preG2: ReturnType<typeof createPreG2Watch>;
}

let fixture: Awaited<ReturnType<typeof createNativeHttpFixture>>;
let providerPrivateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let revocation: typeof import('../../auth/authority/native-revocation-configuration');
let validateToken: typeof import('../../middleware/auth').validateToken;
let parseWatchPairCapability: typeof import('../../auth/watch-pairing-capability').parseWatchPairCapability;
const ownerId = randomUUID();
const ownerEmail = `server-modes-${ownerId}@example.test`;
const password = 'synthetic-server-mode-password';
const g2Recording = recordings.garmin.find((recording) => recording.name === 'g2-reviewed');
const preG2Recording = recordings.garmin.find((recording) => recording.name === 'main-before-g2');
/** A phone and both Garmin checkpoints signed in during the legacy cell, refreshed in every later one. */
const carried = new Map<string, Carried>();
const nativePaths = new Set<string>(Object.values(NATIVE_V1_PATHS));

function signedProviderToken(
  provider: 'apple' | 'google',
  subject: string,
  claims: { email?: string; nonce?: string } = {},
) {
  return new SignJWT({
    sub: subject,
    ...(claims.email ? { email: claims.email, email_verified: true } : {}),
    ...(claims.nonce ? { nonce: claims.nonce } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-provider' })
    .setIssuer(provider === 'apple' ? 'https://appleid.apple.com' : 'https://accounts.google.com')
    .setAudience(provider === 'apple' ? 'com.boardsesh.app' : 'native-contract-google')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(providerPrivateKey);
}

/**
 * The released client's fetch, observed. The frozen signOut sends its revoke
 * without awaiting it, so `settle` waits for every request the client started.
 */
function observedNetwork() {
  const inFlight = new Set<Promise<unknown>>();
  const replies: { path: string; status: number }[] = [];
  const network: typeof fetch = (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    const sent = fixture.network(input, init).then((response) => {
      replies.push({ path, status: response.status });
      return response;
    });
    inFlight.add(sent);
    void sent.finally(() => inFlight.delete(sent)).catch(() => {});
    return sent;
  };
  return {
    network,
    replies,
    async settle() {
      while (inFlight.size) await Promise.allSettled(inFlight);
    },
  };
}

/** The platform Apple/Google buttons return the owner's linked subjects. */
async function releasedClient(release: ReleasedClient, network: typeof fetch) {
  return createReleasedClient(release, {
    fetch: network,
    providerToken: async (provider, nonce) =>
      signedProviderToken(provider, `synthetic-${provider}-${ownerId}`, { nonce }),
  });
}

async function storedPair(client: Client): Promise<Pair> {
  const jwt = await callRecorded(client.store, 'getAuthToken');
  const refreshToken = await callRecorded(client.store, 'getRefreshToken');
  const expiresAt = await callRecorded(client.store, 'getTokenExpiresAt');
  if (typeof jwt !== 'string' || typeof refreshToken !== 'string' || !(expiresAt instanceof Date))
    throw new Error('Released keychain holds no complete pair');
  return { jwt, refreshToken, expiresAt: expiresAt.toISOString() };
}

/** Wire checks shared with released-http.contract.ts, plus the reader every authed request uses. */
async function assertPair(pair: Pair, expectedOwner: string, step: string) {
  expect(pair.refreshToken, step).toMatch(/^[a-f0-9]{64}$/);
  expect(Number.isFinite(Date.parse(pair.expiresAt)), step).toBe(true);
  const verified = await jwtVerify(pair.jwt, new TextEncoder().encode(process.env.NEXTAUTH_SECRET), {
    issuer: 'boardsesh',
    audience: 'boardsesh-mobile',
    algorithms: ['HS256'],
  });
  expect(verified.payload.sub, step).toBe(expectedOwner);
  const rows = await fixture.db
    .select()
    .from(mobileRefreshTokens)
    .where(eq(mobileRefreshTokens.tokenHash, createHash('sha256').update(pair.refreshToken).digest('hex')));
  expect(rows, step).toHaveLength(1);
  expect(rows[0].userId, step).toBe(expectedOwner);
  expect((await validateToken(pair.jwt))?.userId, `${step}: admitted by the request reader`).toBe(expectedOwner);
}

function refreshed(result: unknown) {
  return typeof result === 'boolean' ? result : (result as { status: string }).status === 'refreshed';
}

const watchPost: WatchPost = async (path, body) => {
  fixture.native.__resetNativeAuthStateForTests();
  const response = await fixture.post(path, body);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
};

/** The phone half of Garmin pairing, through the released app's own request and parser. */
async function releasedPairingCode(client: Client) {
  fixture.native.__resetNativeAuthStateForTests();
  const watchPairing = await client.load('packages/mobile/src/lib/watch-pairing.ts');
  return callRecorded(watchPairing, 'requestWatchPairingCode') as Promise<{ code: string; expiresAt: string }>;
}

async function pairWatches(client: Client, owner: string, step: string) {
  if (!g2Recording || !preG2Recording) throw new Error('Garmin recordings missing');
  const g2 = createG2Watch(g2Recording);
  const preG2 = createPreG2Watch(preG2Recording);
  const issuedKinds = new Set<StageEvidence['pairing']>();
  for (const watch of [g2, preG2]) {
    const issued = await releasedPairingCode(client);
    expect(issued.code, step).toMatch(/^[A-Z2-9]{8}$/);
    expect(Date.parse(issued.expiresAt), step).toBeGreaterThan(Date.now());
    // A bare user id is the legacy code; v2 is the source-bound capability.
    const contents = await fixture.redis.getClients().publisher.get(`boardsesh:watch:pair:${issued.code}`);
    if (contents === owner) issuedKinds.add('uid');
    else if (contents && parseWatchPairCapability(contents)?.userId === owner) issuedKinds.add('v2');
    else throw new Error(`${step}: unrecognised pairing code contents`);
    const paired = await watch.pair(issued.code, watchPost);
    expect(paired.status, step).toBe(200);
    expect(paired.refused, step).toBe(false);
    expect(watch.effects, step).toContain('paired');
    expect(watch.paths.pair).toBe(NATIVE_V1_PATHS.watchPair);
    expect(watch.paths.refresh).toBe(NATIVE_V1_PATHS.refresh);
    expect((await watchPost(watch.paths.pair, { code: issued.code })).status, `${step}: replayed code`).toBe(401);
  }
  if (issuedKinds.size !== 1) throw new Error(`${step}: one phone issued two kinds of pairing code`);
  return { g2, preG2, pairing: [...issuedKinds][0] };
}

async function expectWatchRefreshes(watches: Omit<Carried, 'phone'>, owner: string, step: string) {
  const g2Before = watches.g2.effects.length;
  expect((await watches.g2.refresh(watchPost)).status, `${step}: G2 refresh`).toBe(200);
  // The rotated pair satisfied AuthState.accept, and the request waiting in
  // the flight (an offline tick upload) re-fires with it.
  expect(watches.g2.effects.slice(g2Before), step).toEqual(['tick-0:resent']);
  expect(watches.g2.state(), step).toMatchObject({ status: 'active', owner });
  expect((await validateToken(watches.g2.accessJwt() ?? ''))?.userId, step).toBe(owner);
  const preG2Before = watches.preG2.effects.length;
  expect((await watches.preG2.refresh(watchPost)).status, `${step}: pre-G2 refresh`).toBe(200);
  expect(watches.preG2.effects.slice(preG2Before), step).toEqual(['tick-0:resent']);
  expect((await validateToken(watches.preG2.accessJwt() ?? ''))?.userId, step).toBe(owner);
}

/** Every flow a released client has, against one server mode. */
async function runCell(mode: ServerMode, release: ReleasedClient) {
  const observed = observedNetwork();
  const reset = () => fixture.native.__resetNativeAuthStateForTests();
  const cell = `${mode.name} × ${release.tag}`;

  // 1. Sessions from before this mode existed keep refreshing (phone and both watches).
  const previous = carried.get(release.tag);
  let carriedPhone = previous?.phone;
  if (!previous) {
    reset();
    const phone = await releasedClient(release, observed.network);
    expect(await callRecorded(phone.auth, 'signInWithCredentials', ownerEmail, password)).toMatchObject({
      success: true,
    });
    const { g2, preG2 } = await pairWatches(phone, ownerId, `${cell}: carried pairing`);
    carried.set(release.tag, { phone, g2, preG2 });
    carriedPhone = phone;
  } else {
    reset();
    const before = await storedPair(previous.phone);
    expect(refreshed(await callRecorded(previous.phone.interceptor, 'deduplicatedRefresh')), cell).toBe(true);
    const after = await storedPair(previous.phone);
    expect(after.refreshToken, cell).not.toBe(before.refreshToken);
    await assertPair(after, ownerId, `${cell}: carried phone refresh`);
    await expectWatchRefreshes(previous, ownerId, `${cell}: carried watches`);
  }

  // 2. Password sign-in, rotation, and the consumed secret refused.
  reset();
  const passwordPhone = await releasedClient(release, observed.network);
  expect(await callRecorded(passwordPhone.auth, 'signInWithCredentials', ownerEmail, password), cell).toMatchObject({
    success: true,
  });
  const signedIn = await storedPair(passwordPhone);
  await assertPair(signedIn, ownerId, `${cell}: password sign-in`);
  expect(refreshed(await callRecorded(passwordPhone.interceptor, 'deduplicatedRefresh')), cell).toBe(true);
  const rotated = await storedPair(passwordPhone);
  expect(rotated.refreshToken, cell).not.toBe(signedIn.refreshToken);
  await assertPair(rotated, ownerId, `${cell}: refresh`);
  const replay = await fixture.post('/auth/native/refresh', { refreshToken: signedIn.refreshToken });
  expect(replay.status, `${cell}: replayed refresh`).toBe(401);
  expect(await replay.json(), cell).toEqual({ error: 'Invalid refresh token' });

  // 3. Apple and Google return to the existing account through the platform buttons.
  reset();
  const providerPhone = await releasedClient(release, observed.network);
  for (const provider of ['Apple', 'Google']) {
    expect(await callRecorded(providerPhone.auth, `signInWith${provider}`), `${cell}: ${provider}`).toMatchObject({
      success: true,
    });
    await assertPair(await storedPair(providerPhone), ownerId, `${cell}: ${provider} sign-in`);
  }

  // 4. A new Apple subject creates an account on one phone and returns without
  // an email on a second; a new Google subject does both on one phone.
  reset();
  const appleSubject = `server-mode-apple-${randomUUID()}`;
  const appleEmail = `apple-${randomUUID()}@example.test`;
  const firstPhone = await releasedClient(release, observed.network);
  const created = await callRecorded(
    firstPhone.auth,
    'oauthNativeSignIn',
    'apple',
    await signedProviderToken('apple', appleSubject, { email: appleEmail }),
  );
  expect(created, `${cell}: new Apple subject`).toMatchObject({ success: true });
  const [appleUser] = await fixture.db.select().from(users).where(eq(users.email, appleEmail));
  expect(appleUser, cell).toBeDefined();
  await assertPair(await storedPair(firstPhone), appleUser.id, `${cell}: new Apple subject`);
  const secondPhone = await releasedClient(release, observed.network);
  const returning = await callRecorded(
    secondPhone.auth,
    'oauthNativeSignIn',
    'apple',
    await signedProviderToken('apple', appleSubject),
  );
  expect(returning, `${cell}: email-less Apple return`).toMatchObject({ success: true });
  await assertPair(await storedPair(secondPhone), appleUser.id, `${cell}: email-less Apple return`);
  const googleSubject = `server-mode-google-${randomUUID()}`;
  const googleEmail = `google-${randomUUID()}@example.test`;
  reset();
  const googleCreated = await callRecorded(
    providerPhone.auth,
    'oauthNativeSignIn',
    'google',
    await signedProviderToken('google', googleSubject, { email: googleEmail }),
  );
  const [googleUser] = await fixture.db.select().from(users).where(eq(users.email, googleEmail));
  expect(googleUser, `${cell}: new Google subject`).toBeDefined();
  const googleReturning = await callRecorded(
    providerPhone.auth,
    'oauthNativeSignIn',
    'google',
    await signedProviderToken('google', googleSubject),
  );
  await assertPair(await storedPair(providerPhone), googleUser.id, `${cell}: email-less Google return`);
  if (release.version === '2.6.0' || release.version === '2.7.0') {
    for (const [result, userId, provider, accountCreated] of [
      [created, appleUser.id, 'apple', true],
      [returning, appleUser.id, 'apple', false],
      [googleCreated, googleUser.id, 'google', true],
      [googleReturning, googleUser.id, 'google', false],
    ] as const) {
      expect(result, `${cell}: receipt`).toMatchObject({
        userId,
        accountCreation: { userId, accountCreated, provider },
      });
    }
  } else {
    expect(googleCreated, cell).toMatchObject({ success: true });
    expect(googleReturning, cell).toMatchObject({ success: true });
  }

  // 5. Email registration, then the duplicate refused through the released parser.
  reset();
  const registeredEmail = `registration-${randomUUID()}@example.test`;
  const registrationPhone = await releasedClient(release, observed.network);
  expect(
    await callRecorded(registrationPhone.auth, 'registerWithCredentials', registeredEmail, password, 'Server mode'),
    `${cell}: registration`,
  ).toMatchObject({ success: true });
  const [registered] = await fixture.db.select().from(users).where(eq(users.email, registeredEmail));
  expect(registered, cell).toBeDefined();
  await assertPair(await storedPair(registrationPhone), registered.id, `${cell}: registration`);
  expect(
    await callRecorded(registrationPhone.auth, 'registerWithCredentials', registeredEmail, password),
    `${cell}: duplicate registration`,
  ).toMatchObject({ success: false, status: 409 });

  // 6. Garmin pairing from the phone that created the Apple account.
  const appleWatches = await pairWatches(firstPhone, appleUser.id, `${cell}: pairing`);
  await expectWatchRefreshes(appleWatches, appleUser.id, `${cell}: paired watches`);
  const [manifest] = await fixture.db.select().from(authEmailProjection);
  const reservedFor = async (userId: string) =>
    (await fixture.db.select().from(authEmailReservations).where(eq(authEmailReservations.ownerUserId, userId)))
      .length === 1;
  const authorityRows = await fixture.db
    .select({ providerId: authAccount.providerId })
    .from(authAccount)
    .where(
      and(
        eq(authAccount.userId, registered.id),
        eq(authAccount.providerId, 'credential'),
        eq(authAccount.accountId, registered.id),
      ),
    );
  const authorityLinks = await fixture.db
    .select({ providerId: authAccount.providerId })
    .from(authAccount)
    .where(and(eq(authAccount.userId, appleUser.id), eq(authAccount.accountId, appleSubject)));
  const canonicalSessions = await fixture.db
    .select({ id: authSession.id })
    .from(authSession)
    .where(and(eq(authSession.userId, appleUser.id), like(authSession.legacyLineageId, '%native-refresh:%')));
  const evidence: Omit<StageEvidence, 'nativeGeneration'> = {
    manifest: manifest ? (manifest.writerAuthority as StageEvidence['manifest']) : 'none',
    registrationReserved: await reservedFor(registered.id),
    oauthReserved: await reservedFor(appleUser.id),
    authorityRows: authorityRows.length === 1 && authorityLinks.length === 1,
    canonicalSession: canonicalSessions.length > 0,
    pairing: appleWatches.pairing,
  };

  // 7. Sign out on the first phone, then watch what the second phone and both
  // watches of that account see on their next request.
  let forcedSignOuts = 0;
  const localData = release.version.startsWith('2.2.')
    ? await createReleasedProvider(secondPhone, release, true, { forcedSignOut: true })
    : undefined;
  if (!localData)
    await callRecorded(secondPhone.interceptor, 'setOnForcedSignOut', () => {
      forcedSignOuts += 1;
    });
  try {
    const firstPair = await storedPair(firstPhone);
    reset();
    await callRecorded(firstPhone.auth, 'signOut');
    await observed.settle();
    expect(observed.replies.filter((reply) => reply.path === '/auth/native/revoke').at(-1), cell).toEqual({
      path: '/auth/native/revoke',
      status: 200,
    });
    expect(await callRecorded(firstPhone.store, 'getAuthToken'), cell).toBeNull();
    expect(await callRecorded(firstPhone.store, 'getRefreshToken'), cell).toBeNull();
    expect((await fixture.post('/auth/native/refresh', { refreshToken: firstPair.refreshToken })).status, cell).toBe(
      401,
    );

    const secondPair = await storedPair(secondPhone);
    const repliesBefore = observed.replies.length;
    const probe = await releasedPairingCode(secondPhone).then(
      (issued) => ({ issued }),
      // The frozen module throws a VM-realm Error; read its message, not its class.
      (error: unknown) => ({
        error:
          typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error),
      }),
    );
    await observed.settle();
    const probeReplies = observed.replies.slice(repliesBefore);
    if (mode.generation) {
      // App sign-out moved the account's native generation: the other phone's
      // access JWT is refused at once, its refresh is refused, and the frozen
      // interceptor signs it out.
      expect(probe, `${cell}: other phone`).toEqual({ error: 'pair-code 401' });
      expect(
        probeReplies.map((reply) => `${reply.path} ${reply.status}`),
        cell,
      ).toEqual(['/api/watch/pair-code 401', '/auth/native/refresh 401', '/auth/native/revoke 401']);
      expect(await callRecorded(secondPhone.store, 'getAuthToken'), cell).toBeNull();
      expect(await callRecorded(secondPhone.store, 'getRefreshToken'), cell).toBeNull();
    } else {
      // Legacy revocation retires every refresh row of the account but leaves
      // issued access JWTs alone: the other phone keeps working until its next
      // refresh, which is refused.
      expect(probe, `${cell}: other phone`).toMatchObject({ issued: { code: expect.any(String) } });
      if ('issued' in probe)
        await fixture.redis.getClients().publisher.del(`boardsesh:watch:pair:${probe.issued.code}`);
      expect(
        probeReplies.map((reply) => `${reply.path} ${reply.status}`),
        cell,
      ).toEqual(['/api/watch/pair-code 200']);
      expect(await callRecorded(secondPhone.store, 'getAuthToken'), cell).toBe(secondPair.jwt);
      expect((await fixture.post('/auth/native/refresh', { refreshToken: secondPair.refreshToken })).status, cell).toBe(
        401,
      );
    }
    if (localData) {
      // 2.2.x: the provider's own forced sign-out handler ran its full cleanup.
      for (let attempt = 0; attempt < 200 && localData.state.authenticated && mode.generation; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(localData.state.authenticated, cell).toBe(!mode.generation);
      for (const table of USER_TABLES)
        expect(localData.rowCount(table), `${cell}: ${table}`).toBe(mode.generation ? 0 : 1);
      for (const table of localData.boardTables) expect(localData.rowCount(table), cell).toBe(1);
      expect(localData.effects.includes('track:Logout'), cell).toBe(mode.generation);
    } else {
      expect(forcedSignOuts, cell).toBe(mode.generation ? 1 : 0);
    }

    // Both watches: the access JWT follows the native generation, and the
    // refresh row was retired with the rest of the account in every mode.
    for (const watch of [appleWatches.g2, appleWatches.preG2]) {
      expect((await validateToken(watch.accessJwt() ?? ''))?.userId, cell).toBe(
        mode.generation ? undefined : appleUser.id,
      );
    }
    const g2Before = appleWatches.g2.effects.length;
    expect((await appleWatches.g2.refresh(watchPost)).status, cell).toBe(401);
    expect(appleWatches.g2.effects.slice(g2Before), `${cell}: G2 after sign-out`).toEqual([
      'tick-0:failed:401',
      'auth-lost',
    ]);
    expect(appleWatches.g2.state(), cell).toMatchObject({ status: 'empty', owner: null });
    const preG2Before = appleWatches.preG2.effects.length;
    expect((await appleWatches.preG2.refresh(watchPost)).status, cell).toBe(401);
    expect(appleWatches.preG2.effects.slice(preG2Before), `${cell}: pre-G2 after sign-out`).toEqual([
      'tick-0:failed:401',
      'tick-queue-cleared',
      'auth-lost',
    ]);
    expect(appleWatches.preG2.accessJwt(), cell).toBeNull();
  } finally {
    localData?.close();
  }

  const [cutoff] = await fixture.db
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, appleUser.id));
  expect({ ...evidence, nativeGeneration: cutoff?.nativeGeneration ?? null }, `${cell}: stage evidence`).toEqual(
    expectedStageEvidence(mode),
  );

  // Every request the frozen clients made named a documented native path.
  for (const reply of observed.replies) expect(nativePaths.has(reply.path), `${cell}: ${reply.path}`).toBe(true);
  // The account the phones kept signed in is unaffected by the other account's sign-out.
  if (!carriedPhone) throw new Error('Carried phone missing');
  await assertPair(await storedPair(carriedPhone), ownerId, `${cell}: owner`);
}

beforeAll(async () => {
  const keys = await generateKeyPair('RS256');
  providerPrivateKey = keys.privateKey;
  providerJwks.keys = [{ ...(await exportJWK(keys.publicKey)), kid: 'synthetic-provider', alg: 'RS256', use: 'sig' }];
  process.env.GOOGLE_WEB_CLIENT_ID = 'native-contract-google';
  fixture = await createNativeHttpFixture();
  revocation = await import('../../auth/authority/native-revocation-configuration');
  ({ validateToken } = await import('../../middleware/auth'));
  ({ parseWatchPairCapability } = await import('../../auth/watch-pairing-capability'));
  await fixture.db.insert(users).values({ id: ownerId, email: ownerEmail, name: 'Synthetic server-mode owner' });
  await fixture.db.insert(userCredentials).values({ userId: ownerId, passwordHash: await hash(password, 4) });
  await fixture.db.insert(accounts).values(
    (['apple', 'google'] as const).map((provider) => ({
      userId: ownerId,
      type: 'oauth' as const,
      provider,
      providerAccountId: `synthetic-${provider}-${ownerId}`,
    })),
  );
});
afterAll(async () => {
  await fixture?.close();
});

for (const mode of SERVER_MODES) {
  describe(`released clients against server mode: ${mode.name}`, () => {
    beforeAll(async () => {
      for (const name of MODE_SELECTORS) vi.stubEnv(name, '');
      for (const [name, selected] of Object.entries(mode.selectors)) vi.stubEnv(name, selected);
      const epoch = await reachManifest(fixture, mode.manifest);
      if (epoch !== undefined) vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', String(epoch));
      if (mode.generation) vi.spyOn(revocation, 'currentNativeRevocationMode').mockReturnValue('generation');
    });
    afterAll(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    it('records whether production startup accepts these selectors', async () => {
      expect(await startupRefusals(mode.selectors)).toEqual(mode.startup === 'boots' ? [] : mode.startup);
      // A pair issued under this mode keeps the facade's flat reply and JWT claims.
      fixture.native.__resetNativeAuthStateForTests();
      const response = await fixture.post('/auth/native/credentials', { email: ownerEmail, password });
      expect(response.status).toBe(200);
      const issued = (await response.json()) as Pair & { userId: string };
      expect(issued).toMatchObject({
        userId: ownerId,
        jwt: expect.any(String),
        refreshToken: expect.any(String),
        expiresAt: expect.any(String),
      });
      expect(decodeJwt(issued.jwt)).toMatchObject({ sub: ownerId, iss: 'boardsesh', aud: 'boardsesh-mobile' });
    });

    for (const release of recordings.releases) {
      it(`every released flow: ${release.tag}`, async () => {
        await runCell(mode, release);
      });
    }

    if (mode.manifest === 'better-auth') {
      it('refuses legacy native writers with 503 and the released clients keep no tokens', async () => {
        // The staged writers are a prerequisite of the switch, not an option:
        // assertLegacyIdentityWriterAllowed refuses a non-current-store writer.
        vi.stubEnv('CURRENT_STORE_NATIVE_REGISTRATION_MODE', '');
        vi.stubEnv('CURRENT_STORE_NATIVE_OAUTH_MODE', '');
        try {
          for (const release of recordings.releases) {
            fixture.native.__resetNativeAuthStateForTests();
            const phone = await releasedClient(release, observedNetwork().network);
            const email = `legacy-writer-${randomUUID()}@example.test`;
            expect(
              await callRecorded(phone.auth, 'registerWithCredentials', email, password),
              release.tag,
            ).toMatchObject({
              success: false,
              status: 503,
            });
            const subject = `legacy-writer-${randomUUID()}`;
            const refused = await callRecorded(
              phone.auth,
              'oauthNativeSignIn',
              'google',
              await signedProviderToken('google', subject, { email }),
            );
            expect(refused, release.tag).toMatchObject({ success: false, status: 503 });
            expect(await callRecorded(phone.store, 'getAuthToken'), release.tag).toBeNull();
            expect(await fixture.db.select().from(users).where(eq(users.email, email)), release.tag).toHaveLength(0);
          }
        } finally {
          for (const name of ['CURRENT_STORE_NATIVE_REGISTRATION_MODE', 'CURRENT_STORE_NATIVE_OAUTH_MODE'])
            vi.stubEnv(name, mode.selectors[name] ?? '');
        }
      });
    }
  });
}

/**
 * What each release's provider does after the interceptor's forced sign-out.
 * 2.2.x runs above, end to end, against real SQLite. For 2.3 to 2.7 this reads
 * the recorded source and evaluates the recorded table list: the handler forces
 * the full cleanup, which runs clearUserData over a list holding
 * pending_mutations. That is source reading, not an executed provider.
 */
describe('forced sign-out reaches the unsynced-row wipe in every release', () => {
  for (const release of recordings.releases) {
    it(release.tag, async () => {
      const client = await createReleasedClient(release, {
        fetch: async () => {
          throw new Error('No network for a source read');
        },
      });
      const connection = recordedSource(release, release.evidence.connectionPath);
      const tables = release.evidence.clearTables;
      if (!tables) throw new Error('Recorded table list missing');
      const listed = await client.evaluateFragment(
        `${connection.slice(tables.start, tables.end)}\nexport { USER_DATA_TABLES_TO_CLEAR };`,
        {},
      );
      expect(listed.USER_DATA_TABLES_TO_CLEAR).toContain('pending_mutations');
      const provider = recordedSource(release, release.evidence.providerPath);
      const callback = (name: string) => {
        const range = release.evidence.callbacks[name];
        return provider.slice(range.start, range.end);
      };
      expect(callback('clearLocalOfflineUserData')).toContain('clearUserData(localDb)');
      expect(callback('runSignedOutCleanup')).toContain('clearLocalOfflineUserData(');
      const parsed = parseSync(release.evidence.providerPath, provider);
      const component = parsed.program.body.find(
        (node) =>
          node.type === 'ExportNamedDeclaration' &&
          node.declaration?.type === 'FunctionDeclaration' &&
          node.declaration.id?.name === 'AuthProvider',
      );
      const statements =
        component?.type === 'ExportNamedDeclaration' && component.declaration?.type === 'FunctionDeclaration'
          ? (component.declaration.body?.body ?? [])
          : [];
      const registration = statements
        .map((statement) => provider.slice(statement.start, statement.end))
        .filter((source) => source.startsWith('useEffect(') && source.includes('setOnForcedSignOut('));
      expect(registration).toHaveLength(1);
      if (release.version.startsWith('2.2.')) {
        expect(registration[0]).toContain('runSignedOutCleanup().catch(reportError)');
      } else {
        expect(registration[0]).toContain('setOnForcedSignOut(handleForcedSignOut)');
        const forced = statements
          .map((statement) => provider.slice(statement.start, statement.end))
          .filter((source) => source.startsWith('const handleForcedSignOut = useCallback('));
        expect(forced).toHaveLength(1);
        expect(forced[0]).toContain('handleSignedOutTransition(transitionEpoch, true)');
        expect(callback('handleSignedOutTransition')).toMatch(/needsFullCleanup =\s+forceFullCleanup \|\|/);
        expect(callback('handleSignedOutTransition')).toContain('runSignedOutCleanup(');
      }
    });
  }
});
