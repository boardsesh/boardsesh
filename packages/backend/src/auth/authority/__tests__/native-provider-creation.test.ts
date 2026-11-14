import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { authEmailProjection, authWebOAuthIntents, mobileRefreshTokens, users } from '@boardsesh/db/schema/auth';
import { signNativeOAuthAttempt, nativeOAuthAttemptBinding } from '../native-oauth-attempt';
import type { NativeProviderSigninContext } from '@boardsesh/auth-protocol/native-browser-handoff-v1';
import { createProviderSecurityEnvironment } from './provider-security-fixture';
import {
  beginAnonymousProviderSignin,
  prepareAnonymousProviderSignin,
  finalizeAnonymousProviderSignin,
  readAnonymousProviderCreationReceipt,
} from '../anonymous-provider-signin';
import { createUnpublishedBrowserBinding } from '../browser-binding';
import { issueBrowserSourceCapability, type NativeBrowserCreationContext } from '../browser-source-capability';
import { admitBrowserDelegation } from '../browser-delegation';
import { providerTokenHash } from '../provider-security-context';
import { reserveEnforcedEmail } from '../../current-store/email-reservations';

vi.mock('../../credential-database', () => ({ getCredentialDatabase: vi.fn() }));
vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_CONTENT_NATIVE_ISSUER');
      },
    },
  ),
  dbRead: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_CONTENT_NATIVE_READER');
      },
    },
  ),
}));
vi.mock('../../../redis/client', () => ({ redisClientManager: { isRedisConnected: () => false } }));
import { getCredentialDatabase } from '../../credential-database';
import { handleNativeBrowserHandoffIssue } from '../../../handlers/native-browser-handoff';
import { handleNativeAuthExchange, __resetNativeAuthStateForTests } from '../../../handlers/native-auth';

type Authority = 'current-store' | 'better-auth';
type Provider = 'google' | 'apple';
type Kind = 'legacy-jwe' | 'canonical-token';
let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
let server: Server;
let origin: string;
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKey: Awaited<ReturnType<typeof exportJWK>>;
const rpcSecret = 'owned-native-provider-receipt-private-rpc-key-6975';
const nativeSecret = 'owned-native-provider-receipt-distinct-native-key-6975';
const actualFetch = globalThis.fetch;
const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const codec = requireWeb('next-auth/jwt') as {
  encode(input: { secret: string; maxAge: number; token: Record<string, unknown> }): Promise<string>;
};

async function preparedSource(
  authority: Authority,
  provider: Provider,
  kind: Kind,
  existing = false,
  attributed = true,
  requestedReturnUrl?: string,
) {
  await environment.selectAuthority(authority);
  const subject = randomUUID();
  if (existing) {
    const owner = await environment.actor(authority, kind, { provider, subject, password: false });
    const [manifest] = await environment.database.select().from(authEmailProjection);
    const [user] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
    await environment.database.transaction((transaction) =>
      reserveEnforcedEmail(transaction, {
        ...environment.qualification,
        expectedWriterEpoch: manifest.writerEpoch,
        rawEmail: user.email,
        requestedUserId: user.id,
      }),
    );
  }
  const clock = await environment.client<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const startedAt = new Date(clock[0].now).getTime() - 1000;
  const attemptId = requestedReturnUrl
    ? new URL(requestedReturnUrl).searchParams.get('attemptId')
    : randomBytes(16).toString('hex');
  if (!attemptId || !/^[a-f0-9]{32}$/.test(attemptId)) throw new Error('Owned attempt identifier absent');
  const marker = signNativeOAuthAttempt({ attemptId, provider }, environment.secret, startedAt);
  const returnUrl =
    requestedReturnUrl ??
    `https://www.native-provider.example.test/api/auth/native/callback?next=%2F&provider=${provider}&attemptId=${attemptId}`;
  const nativeAttemptHash = nativeOAuthAttemptBinding(marker, returnUrl, provider, environment.secret, startedAt);
  if (!nativeAttemptHash) throw new Error('Owned native marker missing');
  const browser = await createUnpublishedBrowserBinding(environment.database, environment.qualification);
  if (browser.status !== 'created') throw new Error('Owned browser absent');
  const nonce = provider === 'google' ? randomBytes(32).toString('base64url') : null;
  const bound = {
    browser: { bindingToken: browser.token, expectedVersion: browser.cursor.version },
    flowHash: randomBytes(32).toString('hex'),
    nonceHash: nonce ? providerTokenHash(nonce) : null,
    ...(attributed ? { nativeAttemptHash } : {}),
  };
  const intent = await beginAnonymousProviderSignin(environment.database, environment.runtime, {
    ...bound,
    provider,
    credentialKind: kind,
  });
  const seconds = Math.floor(Date.now() / 1000);
  const assertion =
    provider === 'google'
      ? await new SignJWT({
          iss: 'https://accounts.google.com',
          aud: 'owned-google-client',
          sub: subject,
          nonce,
          iat: seconds,
          exp: seconds + 600,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'owned-native-provider-receipt-key' })
          .sign(signingKey.privateKey)
      : null;
  const common = { ...bound, intentToken: intent.intentToken, browserIntentToken: intent.browserIntentToken };
  const prepared = await prepareAnonymousProviderSignin(environment.database, environment.runtime, {
    ...common,
    credentialKind: kind,
    providerProof: {
      provider,
      identity: {
        sub: subject,
        email: `${randomUUID()}@example.test`,
        emailVerified: true,
        name: 'Owned native provider',
        image: null,
      },
      idToken: assertion,
      nonce,
    },
  });
  const proof = prepared.preparation.credentialProof;
  const credential =
    kind === 'canonical-token'
      ? prepared.proposedCanonicalToken!
      : await codec.encode({
          secret: environment.secret,
          maxAge: Date.parse(prepared.preparation.credentialExpiresAt) / 1000 - seconds,
          token: { sub: proof.userId, authSessionId: proof.authSessionId, gen: proof.generation },
        });
  const candidate = { kind, credential };
  const payload = {
    ...common,
    preparationToken: prepared.preparationToken,
    preparation: prepared.preparation,
    candidate,
  };
  const context: NativeProviderSigninContext = {
    receipt: { ...common, preparationToken: prepared.preparationToken, preparation: prepared.preparation },
    attempt: { token: marker, returnUrl },
  };
  return { payload, context, proof, candidate, browser, prepared };
}

async function issue(source: Awaited<ReturnType<typeof preparedSource>>, context = source.context) {
  const response = await actualFetch(`${origin}/api/internal/auth/native-browser-handoff/v1/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rpcSecret}` },
    body: JSON.stringify({
      nativeBrowserHandoffProtocolVersion: 1,
      operation: 'issue',
      requestId: randomUUID(),
      issuedAt: Date.now(),
      payload: {
        bindingToken: source.browser.token,
        actor: {
          version: source.browser.cursor.version + 1,
          credential:
            source.candidate.kind === 'canonical-token'
              ? { kind: 'canonical-token', token: source.candidate.credential }
              : { kind: 'legacy-jwe', credential: source.candidate.credential },
        },
        providerSignin: context,
      },
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
async function exchange(token: string) {
  const response = await actualFetch(`${origin}/auth/native/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transferToken: token }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function mobileBrowserProbe(authority: Authority, provider: Provider, kind: Kind, existing: boolean) {
  const require = createRequire(import.meta.url);
  const child = spawn(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--import',
      require.resolve('tsx'),
      fileURLToPath(
        new URL('../../current-store/__tests__/fixtures/native-browser-creation-mobile-probe.ts', import.meta.url),
      ),
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../../mobile/tsconfig.json', import.meta.url)),
      },
    },
  );
  let report: Record<string, unknown> | undefined;
  let expectedOwner: string | undefined;
  let failure: Error | undefined;
  const timer = setTimeout(() => child.kill('SIGTERM'), 20_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', () => reject(new Error('Owned mobile process failed to start')));
      child.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        const received = message as Record<string, unknown>;
        if (received.type !== 'open-browser') {
          report = received;
          return;
        }
        void (async () => {
          if (typeof received.url !== 'string') throw new Error('Owned browser URL missing');
          const start = new URL(received.url);
          const callback = start.searchParams.get('callbackUrl');
          if (
            start.origin !== 'https://www.native-provider.example.test' ||
            start.pathname !== '/auth/native-start' ||
            start.searchParams.get('provider') !== provider ||
            !callback
          )
            throw new Error('Unexpected mobile browser destination');
          const source = await preparedSource(authority, provider, kind, existing, true, callback);
          expectedOwner = source.proof.userId;
          await finalizeAnonymousProviderSignin(environment.database, environment.runtime, source.payload);
          const issued = await issue(source);
          if (issued.status !== 200 || typeof issued.body.token !== 'string')
            throw new Error('Owned mobile handoff refused');
          child.send({
            type: 'callback',
            url: `com.boardsesh.app://auth/callback?transferToken=${encodeURIComponent(issued.body.token)}`,
          });
        })().catch((error: unknown) => {
          failure = error instanceof Error ? error : new Error('Owned mobile host failed');
          child.kill('SIGTERM');
        });
      });
      child.once('exit', (code) => {
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else
          reject(
            new Error(
              `Owned mobile browser proof failed at ${typeof report?.phase === 'string' ? report.phase : 'unknown'} (${typeof report?.code === 'string' ? report.code : 'unknown'})`,
            ),
          );
      });
      child.send({
        type: 'initialize',
        origin,
        provider,
        expectedCreated: !existing,
        issuerVerificationSecret: environment.secret,
      });
    });
    if (!expectedOwner || !report) throw new Error('Owned mobile report missing');
    return { report, expectedOwnerHash: createHash('sha256').update(expectedOwner).digest('hex') };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}

describe('genuine provider creation through actual native issue and exchange HTTP', () => {
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
    signingKey = await generateKeyPair('RS256');
    publicKey = await exportJWK(signingKey.publicKey);
    server = createServer((request, response) => {
      void (
        request.url?.startsWith('/api/internal/auth/native-browser-handoff/')
          ? handleNativeBrowserHandoffIssue(request, response, environment.database)
          : handleNativeAuthExchange(request, response)
      ).catch(() => {
        response.writeHead(500);
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned HTTP listener missing');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    __resetNativeAuthStateForTests();
    vi.mocked(getCredentialDatabase).mockResolvedValue(environment.database);
    for (const [name, setting] of Object.entries({
      NEXTAUTH_SECRET: environment.secret,
      NATIVE_BROWSER_HANDOFF_SECRET: nativeSecret,
      BROWSER_DELEGATION_SECRET: 'owned-native-provider-distinct-delegation-secret-6975',
      CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
      CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
      CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging',
      CURRENT_STORE_AUTH_PROJECTION_ID: environment.qualification.expectedProjectionId,
      CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
      CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-native-provider-receipt-retirement-key',
      GOOGLE_CLIENT_ID: 'owned-google-client',
      GOOGLE_CLIENT_SECRET: 'owned-google-secret',
      APPLE_ID: 'owned-apple-client',
      APPLE_SECRET: 'owned-apple-secret',
      CURRENT_STORE_PROVIDER_GOOGLE_AUTH_TIME_MODE: 'auth-time-staging',
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      BETTER_AUTH_LEGACY_BRIDGE_MODE: 'off',
      AUTH_IDENTITY_MIRROR: 'on',
    }))
      vi.stubEnv(name, setting);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const address = input instanceof Request ? input.url : String(input);
      if (address === 'https://www.googleapis.com/oauth2/v3/certs')
        return Response.json({
          keys: [{ ...publicKey, alg: 'RS256', kid: 'owned-native-provider-receipt-key', use: 'sig' }],
        });
      throw new Error('Unexpected provider I/O');
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await environment?.close();
  });

  for (const authority of ['current-store', 'better-auth'] as const)
    for (const provider of ['google', 'apple'] as const)
      for (const kind of ['legacy-jwe', 'canonical-token'] as const)
        it.each([false, true])(
          `${authority}/${provider}/${kind} preserves actual existing=%s receipt and unknown age`,
          async (existing) => {
            const source = await preparedSource(authority, provider, kind, existing);
            expect(
              (await finalizeAnonymousProviderSignin(environment.database, environment.runtime, source.payload))
                .outcome,
            ).toBe('committed');
            const issued = await issue(source);
            expect(issued.status, JSON.stringify(issued.body)).toBe(200);
            if (typeof issued.body.token !== 'string') throw new Error('Owned native capability absent');
            expect(
              await admitBrowserDelegation(environment.database, environment.qualification, issued.body.token),
            ).toMatchObject({ status: 'denied' });
            const result = await exchange(issued.body.token);
            expect(result.status, JSON.stringify(result.body)).toBe(200);
            expect(result.body.accountCreation).toEqual({
              userId: source.proof.userId,
              accountCreated: !existing,
              provider,
              createdAt: source.prepared.preparation.identityPlan.user.createdAt,
            });
            expect(result.body.userId).toBe(source.proof.userId);
            expect(typeof result.body.jwt).toBe('string');
            const decoded = await jwtVerify(result.body.jwt as string, new TextEncoder().encode(environment.secret), {
              algorithms: ['HS256'],
              issuer: 'boardsesh',
              audience: 'boardsesh-mobile',
            });
            expect(decoded.payload.auth_time).toBeUndefined();
            expect(decoded.payload.gen).toBe(source.proof.generation);
            expect(decoded.payload.sub).toBe(source.proof.userId);
            expect(await exchange(issued.body.token)).toMatchObject({ status: 409 });
          },
        );

  for (const [authority, provider, kind] of [
    ['current-store', 'google', 'legacy-jwe'],
    ['better-auth', 'apple', 'canonical-token'],
  ] as const)
    it.each([false, true])(
      `${authority}/${provider}/${kind} reaches actual mobile browser fallback with existing=%s`,
      async (existing) => {
        const result = await mobileBrowserProbe(authority, provider, kind, existing);
        expect(result.report).toEqual({
          type: 'result',
          success: true,
          receiptOnWire: true,
          requests: 1,
          opens: 1,
          dismisses: 1,
          unexpectedHostCalls: 0,
          ownerMatches: true,
          creationMatches: true,
          unknownAgePreserved: true,
          storedActualWirePair: true,
          ownerHash: result.expectedOwnerHash,
        });
      },
    );

  it('never commits a pending preparation while trying to read a creation receipt', async () => {
    const source = await preparedSource('current-store', 'apple', 'canonical-token');
    const before = await environment.database.select().from(authWebOAuthIntents);
    await expect(
      readAnonymousProviderCreationReceipt(environment.database, environment.runtime, source.payload),
    ).rejects.toMatchObject({ code: 'replayed' });
    expect(await environment.database.select().from(authWebOAuthIntents)).toEqual(before);
    expect(
      (await finalizeAnonymousProviderSignin(environment.database, environment.runtime, source.payload)).outcome,
    ).toBe('committed');
  });
  it.each(['ordinary-www', 'new-marker', 'query-drift'] as const)(
    'does not attribute genuine creation to %s',
    async (change) => {
      const source = await preparedSource('better-auth', 'apple', 'canonical-token', false, change !== 'ordinary-www');
      await finalizeAnonymousProviderSignin(environment.database, environment.runtime, source.payload);
      const context = structuredClone(source.context);
      if (change === 'new-marker') {
        const callback = new URL(context.attempt.returnUrl);
        context.attempt.token = signNativeOAuthAttempt(
          { attemptId: callback.searchParams.get('attemptId')!, provider: 'apple' },
          environment.secret,
          Date.now(),
        );
      }
      if (change === 'query-drift')
        context.attempt.returnUrl = context.attempt.returnUrl.replace('next=%2F', 'next=%2Fsettings');
      const issued = await issue(source, context);
      expect(issued.status).toBe(200);
      const result = await exchange(issued.body.token as string);
      expect(result.status).toBe(200);
      expect(result.body).not.toHaveProperty('accountCreation');
    },
  );
  it.each(['epoch', 'cursor', 'sid', 'generation', 'deadline'] as const)(
    'retains the captured completed receipt %s through the source issuer boundary',
    async (changed) => {
      const source = await preparedSource('better-auth', 'apple', 'canonical-token');
      await finalizeAnonymousProviderSignin(environment.database, environment.runtime, source.payload);
      const receipt = await readAnonymousProviderCreationReceipt(
        environment.database,
        environment.runtime,
        source.payload,
      );
      const captured: NativeBrowserCreationContext = {
        proof: { ...source.proof },
        cursor: { ...receipt.browserCursor, bindingExpiresAt: receipt.browserCursor.bindingExpiresAt.toISOString() },
        authority: { ...receipt.authority },
        credentialExpiresAt: source.prepared.preparation.credentialExpiresAt,
        receiptExpiresAt: Date.parse(source.prepared.preparation.expiresAt),
        metadata: {
          ...receipt.accountCreation,
          attemptId: 'a'.repeat(32),
          completedAt: Date.parse(receipt.completedAt),
        },
      };
      const altered = structuredClone(captured);
      if (changed === 'epoch') Object.assign(altered.authority, { epoch: altered.authority.epoch + 1 });
      if (changed === 'cursor') Object.assign(altered.cursor, { version: altered.cursor.version + 1 });
      if (changed === 'sid') Object.assign(altered.proof, { authSessionId: randomUUID() });
      if (changed === 'generation') Object.assign(altered.proof, { generation: altered.proof.generation + 1 });
      if (changed === 'deadline') Object.assign(altered, { receiptExpiresAt: Date.parse(receipt.observedAt) - 1 });
      const result = await issueBrowserSourceCapability(
        environment.database,
        environment.qualification,
        'native-handoff',
        {
          bindingToken: source.browser.token,
          actor: {
            version: receipt.browserCursor.version,
            credential: { kind: 'canonical-token', token: source.candidate.credential },
          },
        },
        process.env,
        altered,
      );
      expect(result.status).toBe('conflict');
      expect(
        await environment.database
          .select()
          .from(mobileRefreshTokens)
          .where(eq(mobileRefreshTokens.userId, source.proof.userId)),
      ).toEqual([]);
    },
  );
  it('refuses a forged creation bit under an otherwise valid selected credential', async () => {
    const source = await preparedSource('current-store', 'apple', 'canonical-token', true);
    await finalizeAnonymousProviderSignin(environment.database, environment.runtime, source.payload);
    const context = structuredClone(source.context);
    context.receipt.preparation.identityPlan.kind = 'new';
    const before = await environment.database
      .select()
      .from(mobileRefreshTokens)
      .where(eq(mobileRefreshTokens.userId, source.proof.userId));
    expect((await issue(source, context)).status).toBe(503);
    expect(
      await environment.database
        .select()
        .from(mobileRefreshTokens)
        .where(eq(mobileRefreshTokens.userId, source.proof.userId)),
    ).toEqual(before);
  });
});
