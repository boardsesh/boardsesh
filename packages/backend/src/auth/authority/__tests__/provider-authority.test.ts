import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { eq, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { executeFirstRow } from '@boardsesh/db/client';
import { jwtVerify } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authAccount,
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  authSubjectCutoffs,
  mobileRefreshTokens,
  userProfiles,
  users,
} from '@boardsesh/db/schema';
import {
  WEB_OAUTH_COMMAND_PATHS,
  WEB_OAUTH_PROTOCOL_VERSION,
  type WebOAuthIntentCommand,
  type WebOAuthResolveCommand,
} from '@boardsesh/auth-protocol';
import { createEnvironment } from './environment';
import { bindIdentityAuthority } from '../identity-authority';
import * as identityStorage from '../identity-authority';
import * as reverseIdentity from '../reverse-identity';
import * as forwardIdentity from '../sync-identity';
import { captureIdentityAuthority, switchIdentityAuthority, type IdentityAuthorityName } from '../router';
import { CURRENT_EMAIL_NORMALIZER_VERSION, type CurrentStoreTransaction } from '../../current-store/foundation-context';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../../current-store/email-reservations';
import { recordWebOAuthIntent, resolveWebOAuthIdentity } from '../../current-store/web-oauth-identity';
import { handleCurrentStoreWebOAuth } from '../../../handlers/current-store-web-oauth';
import { handleNativeAuthOAuth, __resetNativeAuthStateForTests } from '../../../handlers/native-auth';
import { createNativeOAuthProviderFixture } from '../../current-store/__tests__/fixtures/native-oauth-provider-fixture';

// No issuer or selected reader may fall back to the process database singleton.
vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error('Uninjected provider database');
      },
    },
  ),
}));
const verificationPhase = vi.hoisted(() => ({ afterProviderProof: undefined as (() => Promise<void>) | undefined }));
vi.mock('jose', async (original) => {
  const actual = await original<typeof import('jose')>();
  return {
    ...actual,
    jwtVerify: async (...parameters: Parameters<typeof actual.jwtVerify>) => {
      const result = await actual.jwtVerify(...parameters);
      if (result.payload.iss === 'https://appleid.apple.com' || result.payload.iss === 'https://accounts.google.com')
        await verificationPhase.afterProviderProof?.();
      return result;
    },
  };
});

let environment: Awaited<ReturnType<typeof createEnvironment>>;
let providers: Awaited<ReturnType<typeof createNativeOAuthProviderFixture>>;
let server: Server;
let origin: string;
let restoreFetch: () => void;
const pending = new Set<Promise<unknown>>();
const projectionId = randomUUID();
const secret = 'owned-provider-authority-native-signing-secret';
const rpcSecret = 'owned-provider-authority-private-rpc-secret';
const googleAudience = 'owned-provider-authority-google';
const authority = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
  expectedWriterEpoch: 1,
};
type Platform = 'web' | 'native';
function webCommand<Operation extends 'intent' | 'resolve'>(
  operation: Operation,
  payload: Operation extends 'intent' ? WebOAuthIntentCommand['payload'] : WebOAuthResolveCommand['payload'],
) {
  return {
    webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
    operation,
    requestId: randomUUID(),
    issuedAt: new Date().toISOString(),
    ...(operation === 'resolve' ? { credentialProofVersion: 1 } : {}),
    payload,
  };
}
async function post(path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rpcSecret}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
async function resolve(
  platform: Platform,
  subject: string,
  email: string | null,
  provider: 'apple' | 'google' = 'apple',
) {
  if (platform === 'native')
    return post('/auth/native/oauth', {
      provider,
      identityToken: await providers.sign(provider, { sub: subject, email, email_verified: true }),
      name: { firstName: 'Native', lastName: 'Climber' },
    });
  const flow = randomBytes(32).toString('hex');
  const intent = await post(
    WEB_OAUTH_COMMAND_PATHS.intent,
    webCommand('intent', { provider, flow, actorCookie: null }),
  );
  expect(intent.status).toBe(200);
  return post(
    WEB_OAUTH_COMMAND_PATHS.resolve,
    webCommand('resolve', {
      provider,
      flow,
      actorCookie: null,
      subject,
      email,
      name: 'Web Climber',
      image: 'https://example.test/avatar.png',
    }),
  );
}
function owner(platform: Platform, body: Record<string, unknown>): string {
  const userId = platform === 'native' ? body.userId : (body.user as { id: string }).id;
  if (typeof userId !== 'string') throw new Error('Missing public owner');
  return userId;
}
async function select(to: IdentityAuthorityName) {
  await environment.database.transaction(async (transaction) => {
    const [manifest] = await transaction.select().from(authEmailProjection);
    if (manifest.writerAuthority !== to)
      await switchIdentityAuthority(transaction, {
        projectionId,
        epoch: manifest.writerEpoch,
        from: manifest.writerAuthority,
        to,
      });
  });
}
async function seed(selected: IdentityAuthorityName, subject = randomUUID()) {
  await select(selected);
  const userId = randomUUID();
  const email = `existing-${userId}@example.test`;
  const verifiedAt = new Date('2025-01-02T03:04:05.123Z');
  await environment.database.transaction(async (transaction) => {
    const receipt = await captureIdentityAuthority(transaction, authority);
    const storage = bindIdentityAuthority(transaction, receipt);
    await storage.createUser({ id: userId, email, name: 'Original climber', emailVerified: verifiedAt });
    await reserveEnforcedEmail(transaction, {
      ...authority,
      expectedWriterEpoch: receipt.epoch,
      rawEmail: email,
      requestedUserId: userId,
    });
    await storage.insertProvider({ userId, provider: 'apple', subject }, 0);
  });
  return { userId, email, subject, verifiedAt };
}
async function snapshot() {
  return {
    users: await environment.database.select().from(users),
    legacy: await environment.database.select().from(accounts),
    canonical: await environment.database.select().from(authAccount),
    reservations: await environment.database.select().from(authEmailReservations),
    members: await environment.database.select().from(authEmailReservationMembers),
    profiles: await environment.database.select().from(userProfiles),
    refresh: await environment.database.select().from(mobileRefreshTokens),
  };
}

beforeAll(async () => {
  providers = await createNativeOAuthProviderFixture({
    googleAudience,
    appleAudience: process.env.APPLE_BUNDLE_ID ?? 'com.boardsesh.app',
  });
  server = createServer((request, response) => {
    const operation =
      request.url === '/auth/native/oauth'
        ? handleNativeAuthOAuth(request, response, environment.database)
        : handleCurrentStoreWebOAuth(request, response, environment.database);
    pending.add(operation);
    void operation
      .catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
      })
      .finally(() => pending.delete(operation));
  });
  await new Promise<void>((complete) => server.listen(0, '127.0.0.1', complete));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing owned provider HTTP listener');
  origin = `http://127.0.0.1:${address.port}`;
  restoreFetch = providers.installFetch([origin]);
});
beforeEach(async () => {
  environment = await createEnvironment();
  await environment.database.transaction(async (transaction) => {
    await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
    await transaction.update(authEmailProjection).set({ phase: 'enforced' });
  });
  __resetNativeAuthStateForTests();
  vi.stubEnv('AUTH_IDENTITY_MIRROR', 'off');
  vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
  vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
  vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'owned-provider-authority-deleted-address-digest-key');
  vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', rpcSecret);
  vi.stubEnv('CURRENT_STORE_NATIVE_OAUTH_MODE', 'reserved-staging');
  vi.stubEnv('CURRENT_STORE_NATIVE_REGISTRATION_MODE', 'reserved-staging');
  vi.stubEnv('CURRENT_STORE_WEB_OAUTH_MODE', 'backend-staging');
  vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
  vi.stubEnv('AUTH_CUTOFF_ENFORCEMENT', 'enforce');
  vi.stubEnv('NEXTAUTH_SECRET', secret);
  vi.stubEnv('GOOGLE_CLIENT_ID', googleAudience);
  vi.stubEnv('AUTH_LEGACY_BRIDGE_MODE', 'off');
  vi.stubEnv('PARTNER_OAUTH_MODE', 'off');
});
afterEach(async () => {
  verificationPhase.afterProviderProof = undefined;
  await Promise.allSettled(pending);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await environment?.close();
});
afterAll(async () => {
  restoreFetch?.();
  if (server) await new Promise<void>((complete) => server.close(() => complete()));
});

for (const selected of ['current-store', 'better-auth'] as const) {
  describe(`${selected} provider authority`, () => {
    for (const platform of ['web', 'native'] as const) {
      it(`${platform} creates through its selected writer with unchanged creation policy`, async () => {
        await select(selected);
        if (selected === 'current-store') vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
        const subject = randomUUID();
        const email = `Mixed.${randomUUID()}@Example.test`;
        const result = await resolve(platform, subject, email);
        expect(result.status).toBe(200);
        const userId = owner(platform, result.body);
        const saved = await snapshot();
        expect(saved.users).toHaveLength(1);
        expect(saved.users[0]).toMatchObject({
          id: userId,
          email: email.toLowerCase(),
          name: platform === 'web' ? 'Web Climber' : 'Native Climber',
          image: platform === 'web' ? 'https://example.test/avatar.png' : null,
        });
        expect(saved.users[0].emailVerified).toEqual(platform === 'web' ? null : expect.any(Date));
        expect(saved.legacy).toHaveLength(1);
        expect(saved.legacy[0]).toMatchObject({ userId, provider: 'apple', providerAccountId: subject });
        expect(saved.canonical).toHaveLength(1);
        expect(saved.canonical[0]).toMatchObject({
          userId,
          providerId: 'apple',
          accountId: subject,
          sourceGeneration: 0,
        });
        expect(saved.profiles).toHaveLength(1);
        expect(saved.reservations[0]).toMatchObject({ normalizedEmail: email.toLowerCase(), ownerUserId: userId });
        expect(saved.members).toHaveLength(1);
        expect(saved.refresh).toHaveLength(platform === 'native' ? 1 : 0);
        if (platform === 'native') {
          expect(result.body.accountCreation).toMatchObject({ userId, accountCreated: true, provider: 'apple' });
          const verified = await jwtVerify(result.body.jwt as string, new TextEncoder().encode(secret), {
            issuer: 'boardsesh',
            audience: 'boardsesh-mobile',
          });
          expect(verified.payload.sub).toBe(userId);
        }
      });
      it(`${platform} returning no-email Apple identity uses selected subject ownership and keeps stored identity`, async () => {
        const existing = await seed(selected);
        const result = await resolve(platform, existing.subject, null);
        expect(result.status).toBe(200);
        expect(owner(platform, result.body)).toBe(existing.userId);
        const saved = await snapshot();
        expect(saved.users).toHaveLength(1);
        expect(saved.users[0]).toMatchObject({
          email: existing.email,
          name: 'Original climber',
          emailVerified: existing.verifiedAt,
        });
        expect(saved.legacy).toHaveLength(1);
        expect(saved.canonical).toHaveLength(selected === 'better-auth' ? 1 : 0);
        if (platform === 'native')
          expect(result.body.accountCreation).toMatchObject({ accountCreated: false, userId: existing.userId });
      });
      it(`${platform} rolls back identity, reservation, profile and issued refresh if the directional mirror fails`, async () => {
        await select(selected);
        if (selected === 'current-store') {
          vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
          const actual = forwardIdentity.mirrorIdentityIfEnabled;
          vi.spyOn(forwardIdentity, 'mirrorIdentityIfEnabled').mockImplementation(async (...parameters) => {
            await actual(...parameters);
            throw new Error('Synthetic post-forward-mirror failure');
          });
        } else {
          const actual = reverseIdentity.mirrorAuthorityToCurrentStore;
          vi.spyOn(reverseIdentity, 'mirrorAuthorityToCurrentStore').mockImplementation(async (...parameters) => {
            await actual(...parameters);
            throw new Error('Synthetic post-reverse-mirror failure');
          });
        }
        const before = await snapshot();
        const result = await resolve(platform, randomUUID(), `${randomUUID()}@example.test`);
        expect(result.status).toBeGreaterThanOrEqual(500);
        expect(await snapshot()).toEqual(before);
      });
    }
    it('keeps deleted provider ownership visible for denial without recreating the account', async () => {
      const existing = await seed(selected);
      await environment.database.insert(authSubjectCutoffs).values({
        userId: existing.userId,
        generation: 1,
        revokedThrough: new Date(),
        deletedAt: new Date(),
        lastOperationId: randomUUID(),
      });
      const before = await snapshot();
      expect((await resolve('native', existing.subject, null)).status).toBe(401);
      expect(await snapshot()).toEqual(before);
    });
    it('rechecks selected provider owner after the user lock rather than trusting the initial snapshot', async () => {
      const existing = await seed(selected);
      const otherUserId = randomUUID();
      await environment.database.insert(users).values({ id: otherUserId, email: `other-${otherUserId}@example.test` });
      const actual = identityStorage.bindIdentityAuthority;
      let changed = false;
      vi.spyOn(identityStorage, 'bindIdentityAuthority').mockImplementation((transaction, receipt) => {
        const storage = actual(transaction, receipt);
        return {
          ...storage,
          async findProvider(provider, subject) {
            const found = await storage.findProvider(provider, subject);
            if (found && !changed) {
              changed = true;
              if (selected === 'better-auth')
                await environment.database
                  .update(authAccount)
                  .set({ userId: otherUserId })
                  .where(and(eq(authAccount.providerId, provider), eq(authAccount.accountId, subject)));
              else
                await environment.database
                  .update(accounts)
                  .set({ userId: otherUserId })
                  .where(and(eq(accounts.provider, provider), eq(accounts.providerAccountId, subject)));
            }
            return found;
          },
        };
      });
      expect((await resolve('native', existing.subject, null)).status).toBe(503);
      expect(changed).toBe(true);
      expect((await snapshot()).refresh).toHaveLength(0);
    });
  });
}

it.each(['web', 'native'] as const)(
  '%s refuses canonical provider generations older than the locked account cutoff',
  async (platform) => {
    const existing = await seed('better-auth');
    await environment.database
      .insert(authSubjectCutoffs)
      .values({ userId: existing.userId, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
    const before = await snapshot();
    expect((await resolve(platform, existing.subject, null)).status).toBe(503);
    expect(await snapshot()).toEqual(before);
  },
);

it.each(['web', 'native'] as const)(
  '%s refuses a reverse mirror that would reassign another legacy provider owner',
  async (platform) => {
    const existing = await seed('better-auth');
    const otherUserId = randomUUID();
    await environment.database.insert(users).values({ id: otherUserId, email: `other-${otherUserId}@example.test` });
    await environment.database.insert(accounts).values({
      userId: otherUserId,
      type: 'oauth',
      provider: 'apple',
      providerAccountId: existing.subject,
    });
    const before = await snapshot();
    expect((await resolve(platform, existing.subject, null)).status).toBeGreaterThanOrEqual(500);
    expect(await snapshot()).toEqual(before);
  },
);
it('refuses an authority switch that completes during real native provider verification', async () => {
  const before = await snapshot();
  verificationPhase.afterProviderProof = async () => {
    verificationPhase.afterProviderProof = undefined;
    await select('better-auth');
  };
  expect((await resolve('native', randomUUID(), `${randomUUID()}@example.test`)).status).toBe(503);
  expect(await snapshot()).toEqual(before);
});

it.each(['current-store', 'better-auth'] as const)(
  '%s rejects a provider snapshot taken before a concurrent generation change',
  async (selected) => {
    const existing = await seed(selected);
    const actual = identityStorage.bindIdentityAuthority;
    let advanced = false;
    vi.spyOn(identityStorage, 'bindIdentityAuthority').mockImplementation((transaction, receipt) => {
      const storage = actual(transaction, receipt);
      return {
        ...storage,
        async findProvider(provider, subject) {
          const found = await storage.findProvider(provider, subject);
          if (found && !advanced) {
            advanced = true;
            await environment.database.transaction(async (writer) => {
              await writer.select().from(users).where(eq(users.id, existing.userId)).for('update');
              await writer.insert(authSubjectCutoffs).values({
                userId: existing.userId,
                generation: 1,
                revokedThrough: new Date(),
                lastOperationId: randomUUID(),
              });
              if (selected === 'better-auth')
                await writer
                  .update(authAccount)
                  .set({ sourceGeneration: 1 })
                  .where(eq(authAccount.userId, existing.userId));
            });
          }
          return found;
        },
      };
    });
    expect((await resolve('native', existing.subject, null)).status).toBe(503);
    expect(advanced).toBe(true);
    expect((await snapshot()).refresh).toHaveLength(0);
  },
);

it.each(['current-store', 'better-auth'] as const)(
  '%s waits for an uncommitted primary provider owner change before its ownership recheck',
  async (selected) => {
    const existing = await seed(selected);
    const otherUserId = randomUUID();
    await environment.database.insert(users).values({ id: otherUserId, email: `other-${otherUserId}@example.test` });
    const observerUrl = new URL(
      process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
    );
    observerUrl.pathname = `/${environment.client.options.database}`;
    const observer = postgres(observerUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} });
    let announceHeld = () => {};
    let release = () => {};
    const held = new Promise<void>((complete) => {
      announceHeld = complete;
    });
    const released = new Promise<void>((complete) => {
      release = complete;
    });
    let blockingPid = 0;
    const holder = environment.database.transaction(async (transaction) => {
      const backend = await executeFirstRow<{ pid: number }>(transaction, sql`SELECT pg_backend_pid() AS pid`);
      blockingPid = backend!.pid;
      if (selected === 'better-auth')
        await transaction
          .update(authAccount)
          .set({ userId: otherUserId })
          .where(and(eq(authAccount.providerId, 'apple'), eq(authAccount.accountId, existing.subject)));
      else
        await transaction
          .update(accounts)
          .set({ userId: otherUserId })
          .where(and(eq(accounts.provider, 'apple'), eq(accounts.providerAccountId, existing.subject)));
      announceHeld();
      await released;
    });
    let request: ReturnType<typeof resolve> | undefined;
    let waiting: Promise<void> | undefined;
    let stopped = false;
    try {
      await Promise.race([
        held,
        holder.then(() => {
          throw new Error('Provider holder ended before acquiring its row');
        }),
      ]);
      request = resolve('native', existing.subject, null);
      waiting = (async () => {
        const deadline = Date.now() + 3000;
        while (!stopped && Date.now() < deadline) {
          const [state] = await observer<
            { waiting: boolean }[]
          >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${blockingPid}=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock') AS waiting`;
          if (state.waiting) return;
          await new Promise((complete) => setTimeout(complete, 10));
        }
        if (stopped) return;
        throw new Error('Provider row lock wait was not observed');
      })();
      await Promise.race([
        waiting,
        request.then(() => {
          throw new Error('Provider lookup passed a held primary row');
        }),
      ]);
      release();
      await holder;
      expect((await request).status).toBe(503);
      expect((await snapshot()).refresh).toHaveLength(0);
    } finally {
      stopped = true;
      release();
      await Promise.allSettled([holder, ...(request ? [request] : [])]);
      await waiting?.catch(() => {});
      await observer.end({ timeout: 3 });
    }
  },
);
it.each(['existing', 'new'] as const)(
  'legacy native OAuth cannot bypass canonical writer selection for an %s subject',
  async (kind) => {
    const existing = await seed('better-auth');
    await environment.database
      .insert(accounts)
      .values({ userId: existing.userId, type: 'oauth', provider: 'apple', providerAccountId: existing.subject });
    vi.stubEnv('CURRENT_STORE_NATIVE_OAUTH_MODE', 'legacy');
    const before = await snapshot();
    const result = await resolve(
      'native',
      kind === 'existing' ? existing.subject : randomUUID(),
      kind === 'existing' ? null : `${randomUUID()}@example.test`,
    );
    expect(result.status).toBe(503);
    expect(await snapshot()).toEqual(before);
  },
);

function mutateAfterReceipt(mutate: () => void) {
  let mutated = false;
  return new Proxy(environment.database, {
    get(target, property, receiver): unknown {
      if (property === 'transaction')
        return async <Result>(operation: (transaction: CurrentStoreTransaction) => Promise<Result>) => {
          const result = await target.transaction(operation);
          if (!mutated) {
            mutated = true;
            mutate();
          }
          return result;
        };
      const member: unknown = Reflect.get(target, property, receiver);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}
it('captures intent primitives before a receipt read yields to caller mutation', async () => {
  const flow = randomBytes(32).toString('hex');
  const input = webCommand('intent', { provider: 'google', flow, actorCookie: null }) as WebOAuthIntentCommand;
  const requestId = input.requestId;
  const reply = await recordWebOAuthIntent(
    mutateAfterReceipt(() => {
      Object.assign(input, { requestId: randomUUID() });
      Object.assign(input.payload, { provider: 'facebook', flow: randomBytes(32).toString('hex') });
    }),
    authority,
    secret,
    input,
  );
  expect(reply).toMatchObject({ requestId, outcome: 'recorded', flow });
});
it('captures provider and identity primitives before a resolve receipt read yields', async () => {
  const flow = randomBytes(32).toString('hex');
  const subject = randomUUID();
  const email = `${randomUUID()}@example.test`;
  await recordWebOAuthIntent(
    environment.database,
    authority,
    secret,
    webCommand('intent', { provider: 'google', flow, actorCookie: null }) as WebOAuthIntentCommand,
  );
  const input = webCommand('resolve', {
    provider: 'google',
    flow,
    actorCookie: null,
    subject,
    email,
    name: null,
    image: null,
  }) as WebOAuthResolveCommand;
  const requestId = input.requestId;
  const reply = await resolveWebOAuthIdentity(
    mutateAfterReceipt(() => {
      Object.assign(input, { requestId: randomUUID(), credentialProofVersion: undefined });
      Object.assign(input.payload, {
        provider: 'facebook',
        subject: 'replacement-subject',
        email: 'replacement@example.test',
        actorCookie: 'forged-actor',
      });
    }),
    authority,
    secret,
    input,
  );
  expect(reply).toMatchObject({
    requestId,
    outcome: 'resolved',
    account: { provider: 'google', providerAccountId: subject },
    user: { email },
  });
});
