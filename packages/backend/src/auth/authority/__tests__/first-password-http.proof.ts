import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  FIRST_PASSWORD_COMMAND_PATHS,
  FIRST_PASSWORD_VERSION,
  AUTH_COMMAND_PATHS,
  AUTH_PROTOCOL_VERSION,
  authCommandReplySchema,
  firstPasswordReplySchema,
  type FirstPasswordOperation,
  type FirstPasswordReply,
  type ProviderSecurityActor,
} from '@boardsesh/auth-protocol';
import {
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authFirstPasswordChallenges,
  authSession,
  authSubjectCutoffs,
  users,
} from '@boardsesh/db/schema/auth';
import { createCredentialWriterEnvironment } from './fixtures/credential-writer-environment';
import { createProviderSecurityDriver } from './provider-security-fixture';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { captureIdentityAuthority, switchIdentityAuthority, type IdentityAuthorityName } from '../router';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { firstPasswordConfiguration } from '../first-password-configuration';
import { firstPasswordTokenHash } from '../first-password-challenges';
import { bindIdentityAuthority } from '../identity-authority';
import { readBrowserBinding } from '../browser-binding';
import { closeCredentialDatabase, getCredentialDatabase } from '../../credential-database';
import { handleFirstPassword } from '../../../handlers/first-password';
import { handleCurrentStoreWebAuth } from '../../../handlers/current-store-web-auth';
import { normalizeAccountEmail } from '../../normalize-email';

vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_SHARED_FIRST_PASSWORD_DATABASE');
      },
    },
  ),
  dbRead: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_SHARED_FIRST_PASSWORD_DATABASE');
      },
    },
  ),
}));
const rpcSecret = 'first-password-owned-default-http-rpc-key-6975';
const sourceSecret = 'first-password-owned-default-http-source-key';
const password = ' new first password from confirmed email ';
const selectedHttpContract = process.env.AUTH_CREDENTIAL_HTTP_CONTRACT;
if (
  selectedHttpContract &&
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
      : 'private-first-password-v1';
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let server: Server;
let origin: string;
let projectionId: string = randomUUID();
async function post(
  operation: FirstPasswordOperation,
  payload: unknown,
  options: {
    readonly authorization?: string;
    readonly method?: string;
    readonly path?: string;
    readonly issuedAt?: string;
  } = {},
) {
  const method = options.method ?? 'POST';
  const response = await fetch(`${origin}${options.path ?? FIRST_PASSWORD_COMMAND_PATHS[operation]}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: options.authorization ?? `Bearer ${rpcSecret}` },
    ...(method === 'GET'
      ? {}
      : {
          body: JSON.stringify({
            firstPasswordVersion: FIRST_PASSWORD_VERSION,
            requestId: randomUUID(),
            issuedAt: options.issuedAt ?? new Date().toISOString(),
            operation,
            payload,
          }),
        }),
  });
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('no-store');
  return { status: response.status, body: (await response.json()) as unknown };
}
function success<Operation extends FirstPasswordOperation>(
  body: unknown,
  operation: Operation,
): Extract<FirstPasswordReply, { operation: Operation }> {
  const reply = firstPasswordReplySchema.parse(body);
  expect(reply.operation).toBe(operation);
  if (reply.operation !== operation || 'code' in reply) throw new Error('Owned first-password HTTP command refused');
  return reply as Extract<FirstPasswordReply, { operation: Operation }>;
}
async function actor(selected: IdentityAuthorityName, kind: ProviderSecurityActor['kind']) {
  const qualification = {
    expectedProjectionId: projectionId,
    expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
  };
  await environment.ownerDatabase.transaction(async (transaction) => {
    const receipt = await captureIdentityAuthority(transaction, qualification);
    if (receipt.authority !== selected)
      await switchIdentityAuthority(transaction, {
        projectionId,
        epoch: receipt.epoch,
        from: receipt.authority,
        to: selected,
      });
  });
  const driver = await createProviderSecurityDriver({
    database: await getCredentialDatabase('private-first-password-v1'),
    runtime: {
      qualification,
      legacySecret: sourceSecret,
      methods: {
        configuredProviders: ['google', 'apple'],
        googleAudience: 'owned-google',
        googleReauthenticationEnabled: true,
      },
    },
  });
  const owner = await driver.actor(selected, kind, {
    password: false,
    provider: 'apple',
    unknownAge: kind === 'legacy-jwe',
  });
  const [user] = await environment.ownerDatabase.select().from(users).where(eq(users.id, owner.userId));
  const normalizedEmail = normalizeAccountEmail(user.email);
  await environment.ownerDatabase
    .insert(authEmailReservations)
    .values({ normalizedEmail, basisProjectionId: projectionId, state: 'owned', ownerUserId: owner.userId });
  await environment.ownerDatabase.insert(authEmailReservationMembers).values({ normalizedEmail, userId: owner.userId });
  return { owner, driver };
}
async function prepare(selected: IdentityAuthorityName, kind: ProviderSecurityActor['kind']) {
  const fixture = await actor(selected, kind);
  const issuedReply = await post('request', { actor: fixture.owner.actor });
  expect(issuedReply.status).toBe(200);
  const issued = success(issuedReply.body, 'request');
  const bound = {
    actor: fixture.owner.actor,
    challengeToken: issued.challengeToken,
    browserIntentToken: issued.browserIntentToken,
  };
  const preparedReply = await post('prepare', {
    ...bound,
    confirmationToken: issued.mailPlan.token,
    password,
    confirmPassword: password,
  });
  expect(preparedReply.status).toBe(200);
  const prepared = success(preparedReply.body, 'prepare');
  const candidate = await fixture.driver.candidate(
    { ...prepared, credentialExpiresAt: new Date(prepared.credentialExpiresAt) },
    kind,
  );
  return { ...fixture, ...issued, ...prepared, ...bound, candidate };
}
async function stored(token: string) {
  const [challenge] = await environment.ownerDatabase
    .select()
    .from(authFirstPasswordChallenges)
    .where(eq(authFirstPasswordChallenges.challengeHash, firstPasswordTokenHash('challenge', token)));
  return challenge;
}
function finalizeInput(command: Awaited<ReturnType<typeof prepare>>) {
  return {
    actor: command.actor,
    challengeToken: command.challengeToken,
    browserIntentToken: command.browserIntentToken,
    preparationToken: command.preparationToken,
    candidate: command.candidate,
  };
}
function recoveryInput(command: Awaited<ReturnType<typeof prepare>>) {
  return { ...finalizeInput(command), recoveryToken: command.recoveryToken };
}
describe('actual default first-password HTTP with one qualified profile4 pool', () => {
  beforeAll(async () => {
    environment = await createCredentialWriterEnvironment(httpContract);
    await environment.owner`REVOKE INSERT,UPDATE,DELETE ON users FROM boardsesh_retired_runtime`;
    await environment.owner`GRANT USAGE ON SCHEMA public TO boardsesh_retired_runtime`;
    await environment.owner`GRANT SELECT ON users,auth_subject_cutoffs,auth_session_denials TO boardsesh_retired_runtime`;
    await expect(environment.legacy`UPDATE users SET name=name WHERE false`).rejects.toMatchObject({ code: '42501' });
    await environment.ownerDatabase.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(authEmailProjection)
        .where(eq(authEmailProjection.isCurrent, true));
      if (existing) {
        if (existing.phase !== 'enforced') throw new Error('Owned HTTP first-password projection required');
        projectionId = existing.projectionId;
      } else {
        await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
        await transaction
          .update(authEmailProjection)
          .set({ phase: 'enforced' })
          .where(eq(authEmailProjection.projectionId, projectionId));
      }
    });
    server = createServer((request, response) => {
      void (request.url === AUTH_COMMAND_PATHS.password
        ? handleCurrentStoreWebAuth(request, response)
        : handleFirstPassword(request, response));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned HTTP address unavailable');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    for (const [name, content] of Object.entries({
      NODE_ENV: 'test',
      CURRENT_STORE_FIRST_PASSWORD_MODE: 'backend-staging',
      CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
      EMAIL_VERIFICATION_ENABLED: 'true',
      CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
      NEXTAUTH_SECRET: sourceSecret,
      CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
      CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
      CURRENT_STORE_DELETED_EMAIL_KEY: 'first-password-owned-unrelated-deleted-email-key',
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      DEBUG_SQL: 'false',
      AUTH_IDENTITY_MIRROR: 'on',
      DATABASE_URL: environment.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: httpContract,
    }))
      vi.stubEnv(name, content);
  });
  afterEach(async () => {
    await closeCredentialDatabase();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await environment?.close();
  });
  for (const selected of ['current-store', 'better-auth'] as const) {
    for (const kind of ['legacy-jwe', 'canonical-token'] as const) {
      it(`${selected}/${kind}: actual default private commands preserve source and share the reviewed web/browser/provider handle`, async () => {
        // Canonical possession has no dependency on the JWE reader key.
        if (kind === 'canonical-token') vi.stubEnv('NEXTAUTH_SECRET', '');
        const fixture = await actor(selected, kind);
        const writer = await getCredentialDatabase('private-first-password-v1');
        for (const contract of ['private-web-v1', 'private-browser-v1', 'private-provider-v1'] as const)
          expect(await getCredentialDatabase(contract)).toBe(writer);
        const principal = await environment.writer`SELECT current_user AS role,session_user AS login`;
        expect(principal[0]).toEqual({ role: 'boardsesh_identity_writer', login: 'boardsesh_identity_writer' });
        const issuedReply = await post('request', { actor: fixture.owner.actor });
        expect(issuedReply.status).toBe(200);
        const issued = success(issuedReply.body, 'request');
        const bound = {
          actor: fixture.owner.actor,
          challengeToken: issued.challengeToken,
          browserIntentToken: issued.browserIntentToken,
        };
        const before = await stored(issued.challengeToken);
        expect(success((await post('read', bound)).body, 'read').outcome).toBe('pending');
        expect(await stored(issued.challengeToken)).toEqual(before);
        expect((await post('read', bound, { method: 'GET' })).status).toBe(400);
        expect(await stored(issued.challengeToken)).toEqual(before);
        const preparedReply = await post('prepare', {
          ...bound,
          confirmationToken: issued.mailPlan.token,
          password,
          confirmPassword: password,
        });
        expect(preparedReply.status).toBe(200);
        const prepared = success(preparedReply.body, 'prepare');
        const absent = await writer.transaction(async (transaction) =>
          bindIdentityAuthority(
            transaction,
            await captureIdentityAuthority(transaction, fixture.driver.qualification),
          ).readPassword(fixture.owner.userId),
        );
        expect(absent).toBeNull();
        const candidate = await fixture.driver.candidate(
          { ...prepared, credentialExpiresAt: new Date(prepared.credentialExpiresAt) },
          kind,
        );
        const command = { ...bound, preparationToken: prepared.preparationToken, candidate };
        const finalized = await post('finalize', command);
        expect(finalized.status).toBe(200);
        const committed = success(finalized.body, 'finalize');
        expect((await stored(issued.challengeToken)).pendingPasswordHash).toBeNull();
        const recovered = await post('recover', { ...command, recoveryToken: issued.recoveryToken });
        expect(recovered.status).toBe(200);
        expect(success(recovered.body, 'recover').candidateCredentialHash).toBe(committed.candidateCredentialHash);
        const credential =
          kind === 'canonical-token'
            ? { kind, token: candidate.credential }
            : { kind, credential: candidate.credential, secret: sourceSecret };
        const current = await readBrowserBinding(
          writer,
          fixture.driver.qualification,
          fixture.owner.actor.browserBindingToken,
          { version: committed.browserCursor.version, credential },
        );
        if (current.status !== 'admitted') throw new Error('Owned HTTP continuation refused');
        expect(current.session).toMatchObject({
          userId: fixture.owner.userId,
          authSessionId: fixture.owner.sid,
          generation: 1,
          authenticatedAt: fixture.owner.authenticatedAt,
          linkGuarded: kind !== 'legacy-jwe',
        });
        expect(current.session.expiresAt.toISOString()).toBe(prepared.credentialExpiresAt);
        const [verified] = await environment.ownerDatabase
          .select()
          .from(users)
          .where(eq(users.id, fixture.owner.userId));
        expect(verified.emailVerified?.toISOString()).toBe(prepared.user.emailVerified);
        const signin = await fetch(`${origin}${AUTH_COMMAND_PATHS.password}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${rpcSecret}` },
          body: JSON.stringify({
            protocolVersion: AUTH_PROTOCOL_VERSION,
            operation: 'password',
            requestId: randomUUID(),
            issuedAt: Date.now(),
            payload: { email: verified.email, password },
          }),
        });
        expect(signin.status).toBe(200);
        const verdict = authCommandReplySchema.parse(await signin.json());
        expect(verdict).toMatchObject({
          operation: 'password',
          outcome: 'authenticated',
          user: { id: fixture.owner.userId },
          verification: { userId: fixture.owner.userId, required: true, verified: true },
        });
        const configuration = firstPasswordConfiguration();
        if (configuration.mode !== 'backend-staging') throw new Error('Owned first-password mode unavailable');
        expect(configuration.runtime.emailBindingKey).toBe(rpcSecret);
      });
    }
  }
  it('rejects disabled, unauthorized, malformed UTF8-sized and stale requests before any command pool is acquired', async () => {
    const payload = {
      actor: {
        kind: 'canonical-token',
        credential: 'unadmitted-source',
        expectedUserId: 'fixed',
        expectedAuthSessionId: 'sid',
        browserBindingToken: 'b'.repeat(43),
        browserVersion: 1,
      },
    };
    // A deliberately invalid target proves early replies do not touch either pool.
    vi.stubEnv('AUTH_IDENTITY_DATABASE_URL', 'not-a-database-url');
    vi.stubEnv('CURRENT_STORE_FIRST_PASSWORD_MODE', 'legacy');
    expect((await post('request', payload)).status).toBe(404);
    vi.stubEnv('CURRENT_STORE_FIRST_PASSWORD_MODE', 'backend-staging');
    expect((await post('request', payload, { authorization: 'Bearer wrong-private-service-secret' })).status).toBe(401);
    expect((await post('request', { ...payload, email: 'attacker@example.test' })).status).toBe(400);
    expect((await post('request', { actor: { ...payload.actor, credential: '🧗'.repeat(4097) } })).status).toBe(400);
    expect((await post('request', payload, { issuedAt: new Date(Date.now() - 300_000).toISOString() })).status).toBe(
      400,
    );
    expect((await post('request', payload, { path: FIRST_PASSWORD_COMMAND_PATHS.read })).status).toBe(400);
  });
  it('requires profile4 rather than falling back to an otherwise valid cached provider profile', async () => {
    const fixture = await actor('better-auth', 'canonical-token');
    await closeCredentialDatabase();
    vi.stubEnv('AUTH_IDENTITY_DATABASE_CONTRACT', 'private-provider-v1');
    const reply = await post('request', { actor: fixture.owner.actor });
    expect(reply.status).toBe(503);
    expect(reply.body).toMatchObject({ outcome: 'unavailable', code: 'authority_unavailable' });
    expect(
      await environment.ownerDatabase
        .select()
        .from(authFirstPasswordChallenges)
        .where(eq(authFirstPasswordChallenges.userId, fixture.owner.userId)),
    ).toHaveLength(0);
  });
  it('never ACKs primary unavailability; exact held-candidate recovery succeeds after restoring the read', async () => {
    const command = await prepare('better-auth', 'canonical-token');
    expect((await post('finalize', finalizeInput(command))).status).toBe(200);
    await environment.owner`REVOKE SELECT ON auth_session FROM boardsesh_identity_writer`;
    try {
      const denied = await post('recover', recoveryInput(command));
      expect(denied.status).toBe(503);
      expect(denied.body).toMatchObject({ outcome: 'unavailable', code: 'authority_unavailable' });
      expect(JSON.stringify(denied.body)).not.toContain('candidateCredentialHash');
    } finally {
      await environment.owner`GRANT SELECT ON auth_session TO boardsesh_identity_writer`;
    }
    const recovered = await post('recover', recoveryInput(command));
    expect(recovered.status).toBe(200);
    expect(success(recovered.body, 'recover').outcome).toBe('recovered');
  });
  it('rolls back password/cutoff/challenge after a real late restricted EXECUTE failure and permits exact retry', async () => {
    const command = await prepare('better-auth', 'canonical-token');
    const before = await stored(command.challengeToken);
    await environment.owner`REVOKE EXECUTE ON FUNCTION public.partner_revoke_user(text) FROM boardsesh_identity_writer`;
    try {
      const denied = await post('finalize', finalizeInput(command));
      expect(denied.status).toBe(503);
      expect(denied.body).toMatchObject({ outcome: 'unavailable', code: 'authority_unavailable' });
      expect(await stored(command.challengeToken)).toEqual(before);
      const [user] = await environment.ownerDatabase.select().from(users).where(eq(users.id, command.owner.userId));
      expect(user.emailVerified).toBeNull();
      expect(
        await environment.ownerDatabase
          .select()
          .from(authSubjectCutoffs)
          .where(eq(authSubjectCutoffs.userId, command.owner.userId)),
      ).toHaveLength(0);
      const [session] = await environment.ownerDatabase
        .select()
        .from(authSession)
        .where(eq(authSession.id, command.owner.sid));
      expect(session.token).toBe(command.owner.actor.credential);
    } finally {
      await environment.owner`GRANT EXECUTE ON FUNCTION public.partner_revoke_user(text) TO boardsesh_identity_writer`;
    }
    expect((await post('finalize', finalizeInput(command))).status).toBe(200);
  });
});
