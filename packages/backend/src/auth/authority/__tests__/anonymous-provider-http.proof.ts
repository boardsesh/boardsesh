import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { eq, sql } from 'drizzle-orm';
import { executeFirstRow } from '@boardsesh/db/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  ANONYMOUS_PROVIDER_PATHS,
  anonymousProviderReplySchema,
  type AnonymousProviderCommand,
  type AnonymousProviderReply,
} from '@boardsesh/auth-protocol';
import {
  accounts,
  authAccount,
  authBrowserBindings,
  authEmailProjection,
  authEmailReservations,
  authSession,
  users,
} from '@boardsesh/db/schema/auth';
import { createCredentialWriterEnvironment } from './fixtures/credential-writer-environment';
import { createProviderSecurityDriver } from './provider-security-fixture';
import { closeCredentialDatabase, getCredentialDatabase } from '../../credential-database';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../../current-store/email-reservations';
import { switchIdentityAuthority } from '../router';
import { providerSecurityConfiguration } from '../provider-security-configuration';
import { createUnpublishedBrowserBinding } from '../browser-binding';
import { providerTokenHash } from '../provider-security-context';
import { handleAnonymousProvider } from '../../../handlers/anonymous-provider';

vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_SHARED_ANONYMOUS_DATABASE');
      },
    },
  ),
  dbRead: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_SHARED_ANONYMOUS_DATABASE');
      },
    },
  ),
}));
const configuredContract = process.env.AUTH_CREDENTIAL_HTTP_CONTRACT ?? 'private-provider-v1';
if (
  configuredContract !== 'private-provider-v1' &&
  configuredContract !== 'private-first-password-v1' &&
  configuredContract !== 'private-native-handoff-v1' &&
  configuredContract !== 'private-browser-renewal-v1'
)
  throw new Error('OWNED_ANONYMOUS_PROVIDER_CONTRACT_REQUIRED');
const contract = configuredContract;
const rpcSecret = 'owned-anonymous-provider-real-http-rpc-secret-6975';
const sourceSecret = 'owned-anonymous-provider-real-http-codec-secret-6975';
const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = requireWeb('next-auth/jwt') as {
  encode(input: { secret: string; maxAge: number; token: Record<string, unknown> }): Promise<string>;
};
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let server: Server;
let origin: string;
let projectionId: string = randomUUID();
async function post(
  operation: AnonymousProviderCommand['operation'],
  payload: unknown,
  authorization = `Bearer ${rpcSecret}`,
) {
  const response = await fetch(`${origin}${ANONYMOUS_PROVIDER_PATHS[operation]}`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({
      anonymousProviderVersion: 1,
      requestId: randomUUID(),
      issuedAt: new Date().toISOString(),
      operation,
      payload,
    }),
  });
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('no-store');
  return { status: response.status, body: (await response.json()) as unknown };
}
function reply<Operation extends AnonymousProviderCommand['operation']>(
  operation: Operation,
  body: unknown,
): Extract<
  AnonymousProviderReply,
  { operation: Operation; outcome: 'recorded' | 'prepared' | 'committed' | 'recovered' | 'aborted' }
> {
  const parsed = anonymousProviderReplySchema.parse(body);
  expect(parsed.operation).toBe(operation);
  expect(['recorded', 'prepared', 'committed', 'recovered', 'aborted']).toContain(parsed.outcome);
  return parsed as Extract<
    AnonymousProviderReply,
    { operation: Operation; outcome: 'recorded' | 'prepared' | 'committed' | 'recovered' | 'aborted' }
  >;
}
async function snapshot() {
  return {
    users: await environment.ownerDatabase.select().from(users).orderBy(users.id),
    current: await environment.ownerDatabase
      .select()
      .from(accounts)
      .orderBy(accounts.provider, accounts.providerAccountId),
    primary: await environment.ownerDatabase.select().from(authAccount).orderBy(authAccount.id),
    reservations: await environment.ownerDatabase
      .select()
      .from(authEmailReservations)
      .orderBy(authEmailReservations.normalizedEmail),
    sessions: await environment.ownerDatabase.select().from(authSession).orderBy(authSession.id),
  };
}
async function selectAuthority(selected: 'current-store' | 'better-auth') {
  await environment.ownerDatabase.transaction(async (transaction) => {
    const [manifest] = await transaction
      .select()
      .from(authEmailProjection)
      .where(eq(authEmailProjection.isCurrent, true));
    if (manifest.writerAuthority !== selected)
      await switchIdentityAuthority(transaction, {
        projectionId,
        epoch: manifest.writerEpoch,
        from: manifest.writerAuthority,
        to: selected,
      });
  });
}
async function prepare(
  selected: 'current-store' | 'better-auth',
  kind: 'legacy-jwe' | 'canonical-token',
  provider: 'google' | 'apple',
  existing = false,
) {
  await selectAuthority(selected);
  const configuration = providerSecurityConfiguration();
  if (configuration.mode !== 'backend-staging') throw new Error('Owned anonymous staging configuration missing');
  const database = await getCredentialDatabase('private-provider-v1');
  const actual = await executeFirstRow<{ role: string; sessionRole: string }>(
    database,
    sql`SELECT current_user AS role, session_user AS "sessionRole"`,
  );
  expect(actual).toEqual({ role: 'boardsesh_identity_writer', sessionRole: 'boardsesh_identity_writer' });
  const subject = randomUUID();
  let ownerId: string | undefined;
  if (existing) {
    const driver = await createProviderSecurityDriver({ database, runtime: configuration.runtime });
    const owner = await driver.actor(selected, kind, { provider, subject, password: false });
    ownerId = owner.userId;
    const [stored] = await environment.ownerDatabase.select().from(users).where(eq(users.id, ownerId));
    const [manifest] = await environment.ownerDatabase
      .select()
      .from(authEmailProjection)
      .where(eq(authEmailProjection.isCurrent, true));
    await environment.ownerDatabase.transaction((transaction) =>
      reserveEnforcedEmail(transaction, {
        expectedProjectionId: projectionId,
        expectedNormalizerVersion: 'js-trim-lower-v1',
        expectedWriterEpoch: manifest.writerEpoch,
        rawEmail: stored.email,
        requestedUserId: stored.id,
      }),
    );
  }
  const binding = await createUnpublishedBrowserBinding(database, configuration.runtime.qualification);
  if (binding.status !== 'created') throw new Error('Owned HTTP anonymous binding initialization failed');
  const browser = { bindingToken: binding.token, expectedVersion: binding.cursor.version };
  const nonce = provider === 'google' ? randomBytes(32).toString('base64url') : null;
  const flowHash = randomBytes(32).toString('hex');
  const nonceHash = nonce ? providerTokenHash(nonce) : null;
  const intentResponse = await post('intent', { browser, provider, credentialKind: kind, flowHash, nonceHash });
  expect(intentResponse.status).toBe(200);
  const intent = reply('intent', intentResponse.body);
  const bound = {
    browser,
    intentToken: intent.intentToken,
    browserIntentToken: intent.browserIntentToken,
    flowHash,
    nonceHash,
  };
  const before = await snapshot();
  const preparedResponse = await post('prepare', {
    ...bound,
    credentialKind: kind,
    providerProof: {
      provider,
      identity: {
        sub: subject,
        email: ` HTTP-Anonymous-${randomUUID()}@Example.Test `,
        emailVerified: true,
        name: 'Owned verified HTTP profile',
        image: null,
      },
      idToken: provider === 'google' ? 'owned-assertion-already-verified-by-web-delegate' : null,
      nonce,
    },
  });
  expect(preparedResponse.status).toBe(200);
  expect(await snapshot()).toEqual(before);
  const prepared = reply('prepare', preparedResponse.body);
  expect(prepared.preparation.credentialProof.authenticatedAt).toBeNull();
  expect(prepared.preparation.credentialProof.linkGuarded).toBe(false);
  if (existing) expect(prepared.preparation.identityPlan.user.id).toBe(ownerId);
  let credential: string;
  if (kind === 'canonical-token') {
    if (!prepared.proposedCanonicalToken) throw new Error('Owned HTTP proposal missing');
    credential = prepared.proposedCanonicalToken;
  } else {
    const proof = prepared.preparation.credentialProof;
    const milliseconds = Math.floor(Date.now() / 1000) * 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(milliseconds);
    try {
      credential = await jwt.encode({
        secret: sourceSecret,
        maxAge: Date.parse(prepared.preparation.credentialExpiresAt) / 1000 - milliseconds / 1000,
        token: { sub: proof.userId, authSessionId: proof.authSessionId, gen: proof.generation },
      });
    } finally {
      clock.mockRestore();
    }
  }
  const final = {
    ...bound,
    preparationToken: prepared.preparationToken,
    preparation: prepared.preparation,
    candidate: { kind, credential },
  };
  return { bound, prepared, final, kind };
}

describe('anonymous provider commands through the actual qualified LOGIN and default HTTP pool', () => {
  beforeAll(async () => {
    environment = await createCredentialWriterEnvironment(contract);
    await environment.ownerDatabase.transaction(async (transaction) => {
      const [manifest] = await transaction
        .select()
        .from(authEmailProjection)
        .where(eq(authEmailProjection.isCurrent, true));
      if (manifest) {
        if (manifest.phase !== 'enforced') throw new Error('Owned anonymous proof requires enforced projection');
        projectionId = manifest.projectionId;
      } else {
        await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
        await transaction.update(authEmailProjection).set({ phase: 'enforced' });
      }
    });
    await environment.owner`GRANT USAGE ON SCHEMA public TO boardsesh_retired_runtime`;
    await environment.owner`GRANT SELECT ON public.users,public.auth_subject_cutoffs,public.auth_session_denials TO boardsesh_retired_runtime`;
    server = createServer((request, response) => {
      void handleAnonymousProvider(request, response).catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned HTTP address missing');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    for (const [name, content] of Object.entries({
      DATABASE_URL: environment.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: contract,
      CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging',
      CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
      CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
      CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
      CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-anonymous-http-retired-email-digest-secret-6975',
      NEXTAUTH_SECRET: sourceSecret,
      GOOGLE_CLIENT_ID: 'owned-anonymous-google-http-client',
      GOOGLE_CLIENT_SECRET: 'owned-anonymous-google-http-secret',
      APPLE_ID: 'owned-anonymous-apple-http-client',
      APPLE_SECRET: 'owned-anonymous-apple-http-secret',
      CURRENT_STORE_PROVIDER_GOOGLE_AUTH_TIME_MODE: 'off',
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      AUTH_IDENTITY_MIRROR: 'on',
      DEBUG_SQL: 'false',
    }))
      vi.stubEnv(name, content);
  });
  afterEach(async () => {
    await closeCredentialDatabase();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await closeCredentialDatabase();
    if (server)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await environment?.close();
  });

  for (const selected of ['current-store', 'better-auth'] as const)
    for (const provider of ['google', 'apple'] as const)
      for (const kind of ['legacy-jwe', 'canonical-token'] as const) {
        it.each([false, true])(
          `${selected}/${provider}/${kind}: existing=%s prepares without identity writes and commits+ACKs exact candidate`,
          async (existing) => {
            const pending = await prepare(selected, kind, provider, existing);
            const completed = await post('finalize', pending.final);
            expect(completed.status).toBe(200);
            expect(reply('finalize', completed.body).outcome).toBe('committed');
            const before = await snapshot();
            const acknowledged = await post('finalize', pending.final);
            expect(acknowledged.status).toBe(200);
            expect(reply('finalize', acknowledged.body).outcome).toBe('recovered');
            expect(await snapshot()).toEqual(before);
            const [binding] = await environment.ownerDatabase
              .select()
              .from(authBrowserBindings)
              .where(eq(authBrowserBindings.id, pending.prepared.browserCursor.bindingId));
            expect(binding.userId).toBe(pending.prepared.preparation.identityPlan.user.id);
            expect(binding.authSessionId).toBe(pending.prepared.preparation.credentialProof.authSessionId);
            expect(binding.authenticatedAt).toBeNull();
            const [currentProvider] = await environment.ownerDatabase
              .select()
              .from(accounts)
              .where(eq(accounts.providerAccountId, pending.prepared.preparation.identityPlan.subject));
            const [primaryProvider] = await environment.ownerDatabase
              .select()
              .from(authAccount)
              .where(eq(authAccount.accountId, pending.prepared.preparation.identityPlan.subject));
            expect(currentProvider.userId).toBe(binding.userId);
            expect(primaryProvider.userId).toBe(binding.userId);
            expect(primaryProvider.sourceGeneration).toBe(pending.prepared.preparation.credentialProof.generation);
          },
        );
      }
  it('unknown preparation cancellation prevents later credential creation through the real LOGIN', async () => {
    const pending = await prepare('better-auth', 'canonical-token', 'apple');
    const aborted = await post('abort', {
      ...pending.bound,
      credentialKind: pending.kind,
      preparationToken: null,
      preparation: null,
    });
    expect(aborted.status).toBe(200);
    const before = await snapshot();
    const finalized = await post('finalize', pending.final);
    expect(finalized.status).not.toBe(200);
    expect(await snapshot()).toEqual(before);
  });
  it('actual revoked INSERT permission fails closed and leaves no partial identity or browser selection', async () => {
    const pending = await prepare('current-store', 'canonical-token', 'apple');
    const before = await snapshot();
    await environment.owner`REVOKE INSERT ON public.users FROM boardsesh_identity_writer`;
    try {
      const result = await post('finalize', pending.final);
      expect(result.status).toBe(503);
      expect(await snapshot()).toEqual(before);
    } finally {
      await environment.resetGrants();
    }
  });
});
