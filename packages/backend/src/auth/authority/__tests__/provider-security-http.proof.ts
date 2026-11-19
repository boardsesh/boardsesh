import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { executeFirstRow } from '@boardsesh/db/client';
import {
  accounts,
  authAccount,
  authEmailProjection,
  authProviderReauthenticationReceipts,
  authProviderSecurityIntents,
  authSession,
  authSubjectCutoffs,
  oauthClient,
  oauthConnections,
  oauthRefreshToken,
  users,
} from '@boardsesh/db/schema/auth';
import {
  PROVIDER_SECURITY_COMMAND_PATHS,
  PROVIDER_SECURITY_VERSION,
  providerSecurityReplySchema,
  type ProviderSecurityCommand,
  type ProviderSecurityReply,
} from '@boardsesh/auth-protocol';
import { createCredentialWriterEnvironment } from './fixtures/credential-writer-environment';
import { createProviderSecurityDriver } from './provider-security-fixture';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { closeCredentialDatabase, getCredentialDatabase } from '../../credential-database';
import { captureIdentityAuthority, switchIdentityAuthority, type IdentityAuthorityName } from '../router';
import { bindIdentityAuthority } from '../identity-authority';
import { providerSecurityConfiguration } from '../provider-security-configuration';
import { providerTokenHash } from '../provider-security-context';
import { sessionTokenDigest } from '../session-token';
import { handleProviderSecurity } from '../../../handlers/provider-security';

vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_SHARED_PROVIDER_DATABASE');
      },
    },
  ),
  dbRead: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_SHARED_PROVIDER_DATABASE');
      },
    },
  ),
}));

const rpcSecret = 'owned-provider-http-service-secret-6975';
const sourceSecret = 'owned-provider-http-source-secret-6975';
const selectedHttpContract = process.env.AUTH_CREDENTIAL_HTTP_CONTRACT;
if (
  selectedHttpContract &&
  selectedHttpContract !== 'private-provider-v1' &&
  selectedHttpContract !== 'private-first-password-v1' &&
  selectedHttpContract !== 'private-native-handoff-v1' &&
  selectedHttpContract !== 'private-browser-renewal-v1'
)
  throw new Error('OWNED_CREDENTIAL_HTTP_CONTRACT_REQUIRED');
const httpContract =
  selectedHttpContract === 'private-browser-renewal-v1'
    ? 'private-browser-renewal-v1'
    : selectedHttpContract === 'private-native-handoff-v1'
      ? 'private-native-handoff-v1'
      : selectedHttpContract === 'private-first-password-v1'
        ? 'private-first-password-v1'
        : 'private-provider-v1';
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let server: Server;
let origin: string;
let projectionId: string = randomUUID();

async function post(
  operation: ProviderSecurityCommand['operation'],
  payload: unknown,
  options: {
    readonly path?: string;
    readonly authorization?: string;
    readonly issuedAt?: string;
  } = {},
) {
  const response = await fetch(`${origin}${options.path ?? PROVIDER_SECURITY_COMMAND_PATHS[operation]}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: options.authorization ?? `Bearer ${rpcSecret}` },
    body: JSON.stringify({
      providerSecurityVersion: PROVIDER_SECURITY_VERSION,
      requestId: randomUUID(),
      issuedAt: options.issuedAt ?? new Date().toISOString(),
      operation,
      payload,
    }),
  });
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('no-store');
  return { status: response.status, body: (await response.json()) as unknown };
}
type MutationReply = Exclude<ProviderSecurityReply, { operation: `signin-${string}` }>;
function expectedReply<Outcome extends MutationReply['outcome']>(
  body: unknown,
  outcome: Outcome,
): Extract<MutationReply, { outcome: Outcome }> {
  const reply = providerSecurityReplySchema.parse(body);
  if (reply.operation.startsWith('signin-')) throw new Error('Unexpected ordinary sign-in reply');
  expect(reply.outcome).toBe(outcome);
  if (reply.outcome !== outcome) throw new Error('Owned provider HTTP operation refused');
  return reply as Extract<MutationReply, { outcome: Outcome }>;
}
async function actor(selected: IdentityAuthorityName, kind: 'legacy-jwe' | 'canonical-token' = 'canonical-token') {
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
  const configuration = providerSecurityConfiguration();
  if (configuration.mode !== 'backend-staging') throw new Error('Owned provider HTTP staging configuration required');
  const driver = await createProviderSecurityDriver({
    database: await getCredentialDatabase('private-provider-v1'),
    runtime: configuration.runtime,
  });
  const subject = randomUUID();
  return { driver, owner: await driver.actor(selected, kind, { provider: 'google', subject }), subject };
}
async function prepare(owner: Awaited<ReturnType<typeof actor>>['owner']) {
  const intent = expectedReply(
    (
      await post('intent', {
        actor: owner.webActor,
        action: 'link',
        provider: 'apple',
        methodId: null,
      })
    ).body,
    'recorded',
  );
  const bound = { actor: owner.webActor, intentToken: intent.intentToken };
  const proof = expectedReply(
    (await post('reauthenticate-password', { ...bound, password: ' exact password ' })).body,
    'proved',
  );
  const flowHash = randomBytes(32).toString('hex');
  expectedReply((await post('bind', { ...bound, flowHash })).body, 'bound');
  const subject = randomUUID();
  const prepared = expectedReply(
    (
      await post('prepare', {
        ...bound,
        reauthenticationToken: proof.reauthenticationToken,
        flowHash,
        providerProof: { provider: 'apple', subject, email: 'different-owner@example.invalid', emailVerified: true },
      })
    ).body,
    'prepared',
  );
  return { intent, bound, proof, prepared, subject };
}
async function partner(userId: string) {
  const clientId = randomUUID();
  const id = randomUUID();
  await environment.ownerDatabase
    .insert(oauthClient)
    .values({ id: clientId, clientId, redirectUris: ['https://owned.example.invalid/callback'] });
  await environment.ownerDatabase.insert(oauthConnections).values({ id, userId, clientId });
  await environment.ownerDatabase.insert(oauthRefreshToken).values({
    id: randomUUID(),
    token: randomUUID(),
    userId,
    clientId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
    scopes: ['profile'],
  });
  return id;
}

describe('provider commands through default HTTP and the qualified provider LOGIN', () => {
  beforeAll(async () => {
    environment = await createCredentialWriterEnvironment(httpContract);
    await environment.ownerDatabase.transaction(async (transaction) => {
      const [manifest] = await transaction
        .select()
        .from(authEmailProjection)
        .where(eq(authEmailProjection.isCurrent, true));
      if (manifest) {
        if (manifest.phase !== 'enforced') throw new Error('Owned provider HTTP proof requires enforced projection');
        projectionId = manifest.projectionId;
      } else {
        await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
        await transaction.update(authEmailProjection).set({ phase: 'enforced' });
      }
    });
    await environment.owner`GRANT USAGE ON SCHEMA public TO boardsesh_retired_runtime`;
    await environment.owner`GRANT SELECT ON public.users,public.auth_subject_cutoffs,public.auth_session_denials TO boardsesh_retired_runtime`;
    server = createServer((request, response) => {
      void handleProviderSecurity(request, response).catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned provider HTTP listener unavailable');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    for (const [name, content] of Object.entries({
      DATABASE_URL: environment.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: httpContract,
      CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging',
      CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
      CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
      CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
      CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-provider-http-retired-address-digest-secret',
      NEXTAUTH_SECRET: sourceSecret,
      GOOGLE_CLIENT_ID: 'owned-google-http-client',
      GOOGLE_CLIENT_SECRET: 'owned-google-http-secret',
      APPLE_ID: 'owned-apple-http-client',
      APPLE_SECRET: 'owned-apple-http-secret',
      CURRENT_STORE_PROVIDER_GOOGLE_AUTH_TIME_MODE: 'off',
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      AUTH_IDENTITY_MIRROR: 'off',
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

  it('refuses default mode, browser-only authorization, stale commands and cross-path/provider claims before opening any pool', async () => {
    vi.stubEnv('AUTH_IDENTITY_DATABASE_URL', 'invalid-owned-url');
    vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'legacy');
    expect(await post('methods', {})).toEqual({ status: 404, body: { error: 'disabled' } });
    vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'backend-staging');
    expect(await post('methods', {}, { authorization: 'Bearer browser-proof' })).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    });
    const placeholder = {
      presented: { kind: 'canonical-token', token: 'owned-placeholder' },
      expectedUserId: 'owned',
      expectedAuthSessionId: 'owned',
    };
    // The browser-binding actor shape is refused by provider link and unlink.
    expect(
      await post('methods', {
        actor: {
          kind: 'canonical-token',
          credential: 'owned-placeholder',
          expectedUserId: 'owned',
          expectedAuthSessionId: 'owned',
          browserBindingToken: 'a'.repeat(43),
          browserVersion: 1,
        },
      }),
    ).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(
      await post('methods', { actor: placeholder }, { issuedAt: new Date(Date.now() - 180_000).toISOString() }),
    ).toMatchObject({ status: 400, body: { error: 'expired_request' } });
    expect(
      await post('methods', { actor: placeholder }, { path: PROVIDER_SECURITY_COMMAND_PATHS.finalize }),
    ).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(
      await post('intent', { actor: placeholder, action: 'link', provider: 'facebook', methodId: null }),
    ).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(
      await post('intent', {
        actor: placeholder,
        action: 'link',
        provider: 'google',
        methodId: null,
        authenticatedAt: new Date().toISOString(),
      }),
    ).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
  });

  for (const selected of ['current-store', 'better-auth'] as const)
    it(`${selected}: actual password proof links and unlinks, keeps this device's session and token, and revokes only affected partner credentials`, async () => {
      const { driver, owner, subject } = await actor(selected);
      const principal = await executeFirstRow<{ role: string; sessionRole: string }>(
        await getCredentialDatabase('private-provider-v1'),
        sql`SELECT current_user AS role,session_user AS "sessionRole"`,
      );
      expect(principal).toEqual({ role: 'boardsesh_identity_writer', sessionRole: 'boardsesh_identity_writer' });
      const beforeUser = (await environment.ownerDatabase.select().from(users).where(eq(users.id, owner.userId)))[0];
      const beforeSession = (
        await environment.ownerDatabase.select().from(authSession).where(eq(authSession.id, owner.sid))
      )[0];
      const owned = expectedReply(
        (await post('owned-provider', { actor: owner.webActor, provider: 'google', subject })).body,
        'owned',
      );
      expect(owned.user.id).toBe(owner.userId);
      expect(owned).not.toHaveProperty('credentialProof');
      const affectedConnection = await partner(owner.userId);
      const unrelated = await driver.actor(selected, 'canonical-token');
      const unrelatedConnection = await partner(unrelated.userId);
      const beforeUnrelated = (
        await environment.ownerDatabase
          .select()
          .from(oauthConnections)
          .where(eq(oauthConnections.id, unrelatedConnection))
      )[0];
      const pending = await prepare(owner);
      const finalPayload = {
        ...pending.bound,
        reauthenticationToken: pending.proof.reauthenticationToken,
        preparationToken: pending.prepared.preparationToken,
      };
      expect(expectedReply((await post('finalize', finalPayload)).body, 'committed').generation).toBe(1);
      expect((await environment.ownerDatabase.select().from(users).where(eq(users.id, owner.userId)))[0]).toEqual(
        beforeUser,
      );
      expect(
        (
          await environment.ownerDatabase
            .select()
            .from(oauthConnections)
            .where(eq(oauthConnections.id, affectedConnection))
        )[0],
      ).toMatchObject({ generation: 1, revocationReason: 'account_security_revocation' });
      expect(
        (
          await environment.ownerDatabase
            .select()
            .from(oauthConnections)
            .where(eq(oauthConnections.id, unrelatedConnection))
        )[0],
      ).toEqual(beforeUnrelated);
      expect(
        await environment.ownerDatabase
          .select()
          .from(oauthRefreshToken)
          .where(eq(oauthRefreshToken.userId, owner.userId)),
      ).toHaveLength(0);
      expect(
        await environment.ownerDatabase
          .select()
          .from(oauthRefreshToken)
          .where(eq(oauthRefreshToken.userId, unrelated.userId)),
      ).toHaveLength(1);
      const recover = {
        ...pending.bound,
        reauthenticationToken: pending.proof.reauthenticationToken,
        recoveryToken: pending.intent.recoveryToken,
      };
      expect(expectedReply((await post('recover', recover)).body, 'recovered').generation).toBe(1);
      // The same cookie keeps working: no token was written.
      const methods = expectedReply((await post('methods', { actor: owner.webActor })).body, 'available');
      const linked = methods.providers.find((method) => method.provider === 'apple');
      if (!linked) throw new Error('Owned linked method not visible');
      const unlink = expectedReply(
        (
          await post('intent', {
            actor: owner.webActor,
            action: 'unlink',
            provider: 'apple',
            methodId: linked.methodId,
          })
        ).body,
        'recorded',
      );
      const unlinkBound = { actor: owner.webActor, intentToken: unlink.intentToken };
      const password = expectedReply(
        (await post('reauthenticate-password', { ...unlinkBound, password: ' exact password ' })).body,
        'proved',
      );
      const prepared = expectedReply(
        (
          await post('prepare', {
            ...unlinkBound,
            reauthenticationToken: password.reauthenticationToken,
            flowHash: null,
            providerProof: null,
          })
        ).body,
        'prepared',
      );
      expect(
        expectedReply(
          (
            await post('finalize', {
              ...unlinkBound,
              reauthenticationToken: password.reauthenticationToken,
              preparationToken: prepared.preparationToken,
            })
          ).body,
          'committed',
        ).generation,
      ).toBe(2);
      const remaining = await environment.ownerDatabase.transaction(async (transaction) => {
        const identity = bindIdentityAuthority(
          transaction,
          await captureIdentityAuthority(transaction, driver.qualification),
        );
        return identity.findProvider('apple', pending.subject);
      });
      expect(remaining).toBeNull();
      expect(
        (
          await environment.ownerDatabase
            .select()
            .from(authSubjectCutoffs)
            .where(eq(authSubjectCutoffs.userId, owner.userId))
        )[0].generation,
      ).toBe(2);
      const afterSession = (
        await environment.ownerDatabase.select().from(authSession).where(eq(authSession.id, owner.sid))
      )[0];
      expect(afterSession).toEqual({ ...beforeSession, revocationGeneration: 2, updatedAt: afterSession.updatedAt });
    });

  for (const selected of ['current-store', 'better-auth'] as const)
    it(`${selected}: a legacy NextAuth cookie reads its methods but cannot start a link it could not survive`, async () => {
      const { owner } = await actor(selected, 'legacy-jwe');
      expectedReply((await post('methods', { actor: owner.webActor })).body, 'available');
      const refused = await post('intent', {
        actor: owner.webActor,
        action: 'link',
        provider: 'apple',
        methodId: null,
      });
      expect(refused).toMatchObject({
        status: 403,
        body: { operation: 'intent', outcome: 'canonical_session_required', code: 'canonical_session_required' },
      });
    });

  it('canonical ownership admission refuses expired proof and returns bounded unavailable on primary failure or oversized UTF8 replies', async () => {
    const { owner, subject } = await actor('better-auth');
    const payload = { actor: owner.webActor, provider: 'google', subject };
    expectedReply((await post('owned-provider', payload)).body, 'owned');
    await environment.owner`REVOKE SELECT ON public.auth_session FROM boardsesh_identity_writer`;
    try {
      const unavailable = await post('owned-provider', payload);
      expect(unavailable.status).toBe(503);
      expectedReply(unavailable.body, 'unavailable');
    } finally {
      await environment.owner`GRANT SELECT ON public.auth_session TO boardsesh_identity_writer`;
    }
    await environment.ownerDatabase
      .update(users)
      .set({ name: '🧗'.repeat(33_000) })
      .where(eq(users.id, owner.userId));
    const oversized = await post('owned-provider', payload);
    expect(oversized.status).toBe(503);
    expectedReply(oversized.body, 'unavailable');
    expect(Buffer.byteLength(JSON.stringify(oversized.body))).toBeLessThan(1024);
    await environment.ownerDatabase
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSession.id, owner.sid));
    expect((await post('owned-provider', payload)).status).toBe(401);
  });

  it('a lost-success ACK stays unavailable while its current primary credential cannot be read', async () => {
    const { owner } = await actor('better-auth');
    const pending = await prepare(owner);
    const committed = expectedReply(
      (
        await post('finalize', {
          ...pending.bound,
          reauthenticationToken: pending.proof.reauthenticationToken,
          preparationToken: pending.prepared.preparationToken,
        })
      ).body,
      'committed',
    );
    const recovery = {
      ...pending.bound,
      reauthenticationToken: pending.proof.reauthenticationToken,
      recoveryToken: pending.intent.recoveryToken,
    };
    await environment.owner`REVOKE SELECT ON public.auth_session FROM boardsesh_identity_writer`;
    try {
      const reply = await post('recover', recovery);
      expect(reply.status).toBe(503);
      expect(expectedReply(reply.body, 'unavailable')).toMatchObject({ code: 'authority_unavailable' });
      expect(reply.body).not.toHaveProperty('generation');
    } finally {
      await environment.owner`GRANT SELECT ON public.auth_session TO boardsesh_identity_writer`;
    }
    expect(expectedReply((await post('recover', recovery)).body, 'recovered').generation).toBe(committed.generation);
  });

  it('a real restricted-role late revocation failure rolls back provider, cutoff and session writes, leaving only terminal intent', async () => {
    const { owner } = await actor('better-auth');
    const pending = await prepare(owner);
    await environment.owner`REVOKE EXECUTE ON FUNCTION public.partner_revoke_user(text) FROM boardsesh_identity_writer`;
    try {
      const reply = await post('finalize', {
        ...pending.bound,
        reauthenticationToken: pending.proof.reauthenticationToken,
        preparationToken: pending.prepared.preparationToken,
      });
      expect(reply.status).toBe(503);
      expectedReply(reply.body, 'unavailable');
    } finally {
      await environment.owner`GRANT EXECUTE ON FUNCTION public.partner_revoke_user(text) TO boardsesh_identity_writer`;
    }
    expect(
      await environment.ownerDatabase
        .select()
        .from(authAccount)
        .where(and(eq(authAccount.userId, owner.userId), eq(authAccount.accountId, pending.subject))),
    ).toHaveLength(0);
    expect(
      await environment.ownerDatabase
        .select()
        .from(accounts)
        .where(and(eq(accounts.userId, owner.userId), eq(accounts.providerAccountId, pending.subject))),
    ).toHaveLength(0);
    expect(
      await environment.ownerDatabase
        .select()
        .from(authSubjectCutoffs)
        .where(eq(authSubjectCutoffs.userId, owner.userId)),
    ).toHaveLength(0);
    expect(
      (await environment.ownerDatabase.select().from(authSession).where(eq(authSession.id, owner.sid)))[0],
    ).toMatchObject({ token: sessionTokenDigest(owner.actor.credential), revocationGeneration: 0 });
    expect(
      (
        await environment.ownerDatabase
          .select()
          .from(authProviderSecurityIntents)
          .where(eq(authProviderSecurityIntents.intentHash, providerTokenHash(pending.intent.intentToken)))
      )[0].phase,
    ).toBe('terminal');
    expect(
      (
        await environment.ownerDatabase
          .select()
          .from(authProviderReauthenticationReceipts)
          .where(
            eq(
              authProviderReauthenticationReceipts.receiptHash,
              providerTokenHash(pending.proof.reauthenticationToken),
            ),
          )
      )[0].consumedAt,
    ).toBeNull();
  });
});
