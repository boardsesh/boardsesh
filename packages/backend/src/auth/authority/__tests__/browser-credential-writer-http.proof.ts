import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { executeFirstRow } from '@boardsesh/db/client';
import { authBrowserBindings, authEmailProjection, authSession, users } from '@boardsesh/db/schema/auth';
import {
  BROWSER_BINDING_COMMAND_PATHS,
  BROWSER_BINDING_PROTOCOL_VERSION,
  browserBindingReplySchema,
  type BrowserBindingCommand,
  type BrowserSourceCredential,
} from '@boardsesh/auth-protocol/browser-binding-v1';
import {
  createCredentialWriterEnvironment,
  grantOwnedCredentialWriterCapabilities,
} from './fixtures/credential-writer-environment';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { closeCredentialDatabase, getCredentialDatabase } from '../../credential-database';
import { switchIdentityAuthority } from '../router';
import { handleBrowserBinding } from '../../../handlers/browser-binding';
import { handleBrowserDelegation } from '../../../handlers/browser-delegation';
import {
  BROWSER_DELEGATION_COMMAND_PATH,
  browserDelegationReplySchema,
} from '@boardsesh/auth-protocol/browser-delegation-v1';
import { validateToken } from '../../../middleware/auth';
import { AuthCredentialRefusedError } from '../../human-admission';

vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_SHARED_BROWSER_DATABASE');
      },
    },
  ),
  dbRead: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_SHARED_BROWSER_DATABASE');
      },
    },
  ),
}));

const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = requireWeb('next-auth/jwt') as {
  encode(input: { secret: string; maxAge: number; token: Record<string, unknown> }): Promise<string>;
};
const rpcSecret = 'owned-browser-http-rpc-service-secret-6975';
const sessionSecret = 'owned-browser-http-session-source-secret-6975';
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
        : selectedHttpContract === 'private-provider-v1'
          ? 'private-provider-v1'
          : 'private-browser-v1';
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let server: Server;
let origin: string;
let projectionId: string = randomUUID();

async function post(
  operation: BrowserBindingCommand['operation'],
  payload: unknown,
  options: {
    readonly authorization?: string;
    readonly path?: string;
    readonly issuedAt?: number;
  } = {},
) {
  const response = await fetch(`${origin}${options.path ?? BROWSER_BINDING_COMMAND_PATHS[operation]}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: options.authorization ?? `Bearer ${rpcSecret}` },
    body: JSON.stringify({
      browserBindingProtocolVersion: BROWSER_BINDING_PROTOCOL_VERSION,
      requestId: randomUUID(),
      issuedAt: options.issuedAt ?? Date.now(),
      operation,
      payload,
    }),
  });
  const body: unknown = await response.json();
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('no-store');
  return { status: response.status, body };
}
async function binding() {
  const created = await post('bootstrap', {});
  expect(created.status).toBe(201);
  const reply = browserBindingReplySchema.parse(created.body);
  if (reply.operation !== 'bootstrap' || reply.outcome !== 'created') throw new Error('Owned bootstrap refused');
  return reply;
}
async function delegate(payload: unknown, options: { authorization?: string; path?: string; issuedAt?: number } = {}) {
  const response = await fetch(`${origin}${options.path ?? BROWSER_DELEGATION_COMMAND_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: options.authorization ?? `Bearer ${rpcSecret}` },
    body: JSON.stringify({
      browserDelegationProtocolVersion: 1,
      operation: 'delegate',
      requestId: randomUUID(),
      issuedAt: options.issuedAt ?? Date.now(),
      payload,
    }),
  });
  const body: unknown = await response.json();
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('no-store');
  return { status: response.status, body };
}
async function issueSource(kind: 'legacy-jwe' | 'canonical-token') {
  const userId = randomUUID();
  const sid = randomUUID();
  const authenticatedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  const expiresAt = new Date(Date.now() + 3_600_000);
  await environment.ownerDatabase
    .insert(users)
    .values({ id: userId, email: `${userId}@example.invalid`, name: 'Owned climber' });
  let credential: BrowserSourceCredential;
  if (kind === 'legacy-jwe')
    credential = {
      kind,
      credential: await jwt.encode({
        secret: sessionSecret,
        maxAge: 3600,
        token: {
          sub: userId,
          authSessionId: sid,
          gen: 0,
          auth_time: authenticatedAt.getTime() / 1000,
          link_guarded: true,
        },
      }),
    };
  else {
    credential = { kind, token: randomUUID() };
    await environment.ownerDatabase.insert(authSession).values({
      id: sid,
      token: credential.token,
      userId,
      expiresAt,
      updatedAt: new Date(),
      revocationGeneration: 0,
      originalAuthenticatedAt: authenticatedAt,
    });
  }
  return { userId, sid, authenticatedAt, expiresAt, credential };
}
async function login(kind: 'legacy-jwe' | 'canonical-token') {
  const created = await binding();
  const source = await issueSource(kind);
  const prepared = browserBindingReplySchema.parse(
    (await post('intent', { bindingToken: created.token, transition: 'login', expectedVersion: 0 })).body,
  );
  if (prepared.operation !== 'intent' || prepared.outcome !== 'prepared') throw new Error('Owned intent refused');
  const payload = { bindingToken: created.token, intentToken: prepared.intentToken, candidate: source.credential };
  const selected = browserBindingReplySchema.parse((await post('login', payload)).body);
  if (selected.operation !== 'login' || selected.outcome !== 'committed' || !selected.session)
    throw new Error('Owned selection refused');
  return {
    created,
    source,
    selected,
    payload,
    actor: { version: selected.cursor.version, credential: source.credential },
  };
}

describe('private browser HTTP commands on the qualified restricted LOGIN', () => {
  beforeAll(async () => {
    environment = await createCredentialWriterEnvironment(httpContract);
    await environment.owner`GRANT USAGE ON SCHEMA public TO boardsesh_retired_runtime`;
    await environment.owner`GRANT SELECT ON public.users,public.auth_subject_cutoffs,public.auth_session_denials TO boardsesh_retired_runtime`;
    await expect(
      environment.legacy`UPDATE public.auth_browser_bindings SET version=version WHERE false`,
    ).rejects.toMatchObject({ code: '42501' });
    await environment.ownerDatabase.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(authEmailProjection)
        .where(eq(authEmailProjection.isCurrent, true));
      if (existing) {
        if (existing.phase !== 'enforced') throw new Error('Owned browser HTTP proof requires enforced projection');
        projectionId = existing.projectionId;
      } else {
        await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
        await transaction.update(authEmailProjection).set({ phase: 'enforced' });
      }
    });
    server = createServer((request, response) => {
      const handler = request.url?.startsWith('/api/internal/auth/browser-delegation/')
        ? handleBrowserDelegation
        : handleBrowserBinding;
      void handler(request, response).catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned browser HTTP server failed to bind');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    for (const [name, content] of Object.entries({
      DATABASE_URL: environment.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: httpContract,
      CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
      CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
      NEXTAUTH_SECRET: sessionSecret,
      BROWSER_DELEGATION_SECRET: 'owned-backend-only-http-delegation-secret-6975',
      CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
      CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
      CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-browser-http-deleted-email-digest-secret',
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      AUTH_IDENTITY_MIRROR: 'on',
      DEBUG_SQL: 'false',
    }))
      vi.stubEnv(name, content);
  });
  afterEach(async () => {
    await closeCredentialDatabase();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await closeCredentialDatabase();
    if (server)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (environment) {
      await grantOwnedCredentialWriterCapabilities(
        environment.owner,
        httpContract === 'private-provider-v1' ? httpContract : 'private-web-v1',
      );
      await environment.close();
    }
  });

  it('keeps default/legacy mode disabled before opening a configured database', async () => {
    vi.stubEnv('CURRENT_STORE_BROWSER_BINDING_MODE', 'legacy');
    vi.stubEnv('AUTH_IDENTITY_DATABASE_URL', 'invalid-owned-url');
    expect(await post('bootstrap', {})).toEqual({ status: 404, body: { error: 'disabled' } });
  });
  it('rejects browser credentials without service authentication before opening a database', async () => {
    vi.stubEnv('AUTH_IDENTITY_DATABASE_URL', 'invalid-owned-url');
    expect(await post('bootstrap', {}, { authorization: 'Bearer owned-browser-source-only' })).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    });
  });
  it('rejects stale commands, path substitution and unknown bootstrap claims before pool construction', async () => {
    vi.stubEnv('AUTH_IDENTITY_DATABASE_URL', 'invalid-owned-url');
    expect((await post('bootstrap', {}, { issuedAt: Date.now() - 180_000 })).body).toEqual({
      error: 'expired_request',
    });
    expect((await post('bootstrap', {}, { path: BROWSER_BINDING_COMMAND_PATHS.read })).body).toEqual({
      error: 'invalid_request',
    });
    expect((await post('bootstrap', { expiresAt: '2099-01-01T00:00:00.000Z' })).body).toEqual({
      error: 'invalid_request',
    });
  });
  it('requires the explicit browser capability instead of accepting the default web profile', async () => {
    vi.stubEnv('AUTH_IDENTITY_DATABASE_CONTRACT', 'private-web-v1');
    const response = await post('bootstrap', {});
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ operation: 'bootstrap', outcome: 'unavailable' });
    expect(JSON.stringify(response.body)).not.toContain(environment.writerUrl);
  });
  it('uses the actual credential LOGIN and a database-clock bounded bootstrap deadline', async () => {
    const before = await executeFirstRow<{ milliseconds: number }>(
      environment.ownerDatabase,
      sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::double precision AS milliseconds`,
    );
    const created = await binding();
    const principal = await executeFirstRow<{ role: string; sessionRole: string }>(
      await getCredentialDatabase('private-browser-v1'),
      sql`SELECT current_user AS role,session_user AS "sessionRole"`,
    );
    expect(principal).toEqual({ role: 'boardsesh_identity_writer', sessionRole: 'boardsesh_identity_writer' });
    const after = await executeFirstRow<{ milliseconds: number }>(
      environment.ownerDatabase,
      sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::double precision AS milliseconds`,
    );
    const lifetime = 30 * 24 * 3_600_000;
    expect(new Date(created.cursor.bindingExpiresAt).getTime()).toBeGreaterThanOrEqual(
      Math.floor(before!.milliseconds) + lifetime,
    );
    expect(new Date(created.cursor.bindingExpiresAt).getTime()).toBeLessThanOrEqual(
      Math.floor(after!.milliseconds) + lifetime,
    );
    expect(browserBindingReplySchema.parse((await post('read', { bindingToken: created.token })).body)).toMatchObject({
      outcome: 'anonymous',
      cursor: created.cursor,
    });
  });
  for (const authority of ['current-store', 'better-auth'] as const)
    for (const kind of ['legacy-jwe', 'canonical-token'] as const) {
      it(`${authority}/${kind}: selects, reads, retries and logs out through default HTTP`, async () => {
        await environment.ownerDatabase.transaction(async (transaction) => {
          const [manifest] = await transaction
            .select()
            .from(authEmailProjection)
            .where(eq(authEmailProjection.isCurrent, true));
          if (manifest.writerAuthority !== authority)
            await switchIdentityAuthority(transaction, {
              projectionId,
              from: manifest.writerAuthority,
              to: authority,
              epoch: manifest.writerEpoch,
            });
        });
        const selected = await login(kind);
        const { created, source, actor } = selected;
        const described = browserBindingReplySchema.parse(
          (await post('describe', { bindingToken: created.token })).body,
        );
        expect(described).toMatchObject({
          outcome: 'known',
          state: 'selected',
          credentialKind: kind,
          cursor: selected.selected.cursor,
        });
        expect(JSON.stringify(described)).not.toContain(source.userId);
        expect((await post('read', { bindingToken: created.token })).status).toBe(401);
        const admitted = browserBindingReplySchema.parse(
          (await post('read', { bindingToken: created.token, actor })).body,
        );
        expect(admitted).toMatchObject({
          outcome: 'admitted',
          session: selected.selected.session,
          user: { id: source.userId },
        });
        const raw = source.credential.kind === 'legacy-jwe' ? source.credential.credential : source.credential.token;
        expect(JSON.stringify(admitted)).not.toContain(raw);
        expect(browserBindingReplySchema.parse((await post('login', selected.payload)).body).outcome).toBe(
          'already-committed',
        );
        const prepared = browserBindingReplySchema.parse(
          (
            await post('intent', {
              bindingToken: created.token,
              actor,
              transition: 'logout',
              expectedVersion: actor.version,
              expectedIdentity: { userId: source.userId, authSessionId: source.sid },
            })
          ).body,
        );
        if (prepared.operation !== 'intent' || prepared.outcome !== 'prepared')
          throw new Error('Owned logout intent refused');
        const loggedOut = browserBindingReplySchema.parse(
          (await post('logout', { bindingToken: created.token, actor, intentToken: prepared.intentToken })).body,
        );
        expect(loggedOut).toMatchObject({ outcome: 'committed', session: null, cursor: { version: 2 } });
        expect(
          browserBindingReplySchema.parse((await post('read', { bindingToken: created.token })).body).outcome,
        ).toBe('anonymous');
        const replay = await post('login', selected.payload);
        expect(replay.status).toBe(401);
        expect(browserBindingReplySchema.parse(replay.body).outcome).toBe('denied');
      });
    }
  it('rechecks a shortened canonical primary expiry and refuses stale possession without fallback', async () => {
    const selected = await login('canonical-token');
    await environment.ownerDatabase
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSession.id, selected.source.sid));
    expect((await post('read', { bindingToken: selected.created.token, actor: selected.actor })).status).toBe(401);
    expect((await post('login', selected.payload)).status).toBe(401);
    const [stored] = await environment.ownerDatabase
      .select({ version: authBrowserBindings.version })
      .from(authBrowserBindings)
      .where(eq(authBrowserBindings.id, selected.selected.cursor.bindingId));
    expect(stored.version).toBe(1);
  });
  it('refuses another selected source even for the same valid account', async () => {
    const selected = await login('legacy-jwe');
    const foreignSid = await jwt.encode({
      secret: sessionSecret,
      maxAge: 3600,
      token: { sub: selected.source.userId, authSessionId: randomUUID(), gen: 0 },
    });
    expect(
      (
        await post('read', {
          bindingToken: selected.created.token,
          actor: { version: 1, credential: { kind: 'legacy-jwe', credential: foreignSid } },
        })
      ).status,
    ).toBe(401);
    expect(
      (await post('read', { bindingToken: selected.created.token, actor: { ...selected.actor, version: 0 } })).status,
    ).toBe(401);
  });

  it('rejects an oversized profile before sending any partial identity reply', async () => {
    const selected = await login('legacy-jwe');
    const oversizedName = 'owned-oversized-profile-'.repeat(4000);
    await environment.ownerDatabase
      .update(users)
      .set({ name: oversizedName })
      .where(eq(users.id, selected.source.userId));
    const refused = await post('read', { bindingToken: selected.created.token, actor: selected.actor });
    expect(refused.status).toBe(503);
    expect(browserBindingReplySchema.parse(refused.body)).toMatchObject({ operation: 'read', outcome: 'unavailable' });
    expect(JSON.stringify(refused.body)).not.toContain('owned-oversized-profile-');
    expect(JSON.stringify(refused.body)).not.toContain(selected.source.userId);
  });

  it('admits the explicit larger request envelope while rejecting oversized raw source bytes', async () => {
    const selected = await login('legacy-jwe');
    const payload = {
      bindingToken: selected.created.token,
      actor: { version: selected.actor.version, credential: { kind: 'legacy-jwe', credential: 'a'.repeat(16_384) } },
    };
    expect((await post('read', payload)).status).toBe(401);
    expect(
      (
        await post('read', {
          ...payload,
          actor: { ...payload.actor, credential: { kind: 'legacy-jwe', credential: 'a'.repeat(16_385) } },
        })
      ).status,
    ).toBe(400);
  });

  it.each([
    ['', 503],
    ['owned-wrong-browser-source-key', 401],
  ] as const)(
    'refuses actual legacy proof with unavailable or incorrect configured key: %s',
    async (configured, status) => {
      const selected = await login('legacy-jwe');
      vi.stubEnv('NEXTAUTH_SECRET', configured);
      const refused = await post('read', { bindingToken: selected.created.token, actor: selected.actor });
      expect(refused.status).toBe(status);
      expect(browserBindingReplySchema.parse(refused.body).outcome).toBe(status === 503 ? 'unavailable' : 'denied');
      vi.stubEnv('NEXTAUTH_SECRET', sessionSecret);
      expect((await post('read', { bindingToken: selected.created.token, actor: selected.actor })).status).toBe(200);
    },
  );

  it('rejects a UTF8 source overflow within the wire budget before constructing a database', async () => {
    vi.stubEnv('AUTH_IDENTITY_DATABASE_URL', 'invalid-owned-url');
    expect(
      await post('read', {
        bindingToken: 'a'.repeat(43),
        actor: { version: 1, credential: { kind: 'legacy-jwe', credential: '🧗'.repeat(4097) } },
      }),
    ).toMatchObject({
      status: 400,
      body: { error: 'invalid_request' },
    });
  });
  for (const authority of ['current-store', 'better-auth'] as const) {
    for (const kind of ['legacy-jwe', 'canonical-token'] as const) {
      it(`delegates actual ${kind} through restricted ${authority} and refuses it after A to B`, async () => {
        await environment.ownerDatabase.transaction(async (transaction) => {
          const [manifest] = await transaction
            .select()
            .from(authEmailProjection)
            .where(eq(authEmailProjection.isCurrent, true));
          if (manifest.writerAuthority !== authority)
            await switchIdentityAuthority(transaction, {
              projectionId,
              epoch: manifest.writerEpoch,
              from: manifest.writerAuthority,
              to: authority,
            });
        });
        const selection = await login(kind);
        const result = await delegate({ bindingToken: selection.created.token, actor: selection.actor });
        expect(result.status).toBe(200);
        const lease = browserDelegationReplySchema.parse(result.body);
        if (lease.outcome !== 'admitted') throw new Error('Owned lease refused');
        expect(lease).toMatchObject({
          userId: selection.source.userId,
          authSessionId: selection.source.sid,
          cursor: selection.selected.cursor,
        });
        expect(await validateToken(lease.token)).toMatchObject({
          isAuthenticated: true,
          userId: selection.source.userId,
          credential: { kind: 'web-session', sessionKeyClaim: selection.source.sid, generationClaim: 0 },
        });
        const actual = selection.source.credential;
        expect(JSON.stringify(lease)).not.toContain(
          actual.kind === 'canonical-token' ? actual.token : actual.credential,
        );
        const next = await issueSource(kind);
        const intent = browserBindingReplySchema.parse(
          (
            await post('intent', {
              bindingToken: selection.created.token,
              actor: selection.actor,
              transition: 'login',
              expectedVersion: selection.actor.version,
            })
          ).body,
        );
        if (intent.operation !== 'intent' || intent.outcome !== 'prepared') throw new Error('Owned switch refused');
        expect(
          (
            await post('login', {
              bindingToken: selection.created.token,
              actor: selection.actor,
              intentToken: intent.intentToken,
              candidate: next.credential,
            })
          ).status,
        ).toBe(200);
        await expect(validateToken(lease.token, { throwOnRefusal: true })).rejects.toBeInstanceOf(
          AuthCredentialRefusedError,
        );
      });
    }
  }
  it('rejects delegation auth, freshness and asserted identity before a database', async () => {
    vi.stubEnv('AUTH_IDENTITY_DATABASE_URL', 'invalid-owned-url');
    const payload = {
      bindingToken: 'a'.repeat(43),
      actor: { version: 0, credential: { kind: 'canonical-token', token: 'owned-source' } },
    };
    expect((await delegate(payload, { authorization: 'Bearer owned-browser-source' })).status).toBe(401);
    expect((await delegate(payload, { issuedAt: Date.now() - 180_000 })).status).toBe(400);
    expect((await delegate({ ...payload, userId: 'asserted-owner' })).status).toBe(400);
    vi.stubEnv('CURRENT_STORE_BROWSER_BINDING_MODE', 'legacy');
    expect((await delegate(payload)).status).toBe(404);
  });
  it('keeps a missing or reused backend issuer key unavailable without exposing source', async () => {
    const selection = await login('canonical-token');
    for (const key of ['', sessionSecret, rpcSecret]) {
      vi.stubEnv('BROWSER_DELEGATION_SECRET', key);
      const result = await delegate({ bindingToken: selection.created.token, actor: selection.actor });
      expect(result.status).toBe(503);
      expect(browserDelegationReplySchema.parse(result.body).outcome).toBe('unavailable');
      expect(JSON.stringify(result.body)).not.toContain(selection.source.userId);
    }
  });
});
