import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { executeFirstRow } from '@boardsesh/db/client';
import { qualifyCredentialWriter } from '@boardsesh/db/credential-writer-acl';
import { authBrowserBindings, authBrowserRenewals, authEmailProjection, authSession } from '@boardsesh/db/schema/auth';
import {
  BROWSER_RENEWAL_COMMAND_PATHS,
  browserRenewalReplySchema,
  type BrowserRenewalCommand,
  type BrowserRenewalReply,
} from '@boardsesh/auth-protocol/browser-renewal-v1';
import { createCredentialWriterEnvironment } from './fixtures/credential-writer-environment';
import { createProviderSecurityDriver } from './provider-security-fixture';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { closeCredentialDatabase, getCredentialDatabase } from '../../credential-database';
import { beginBrowserIntent } from '../browser-binding';
import { switchIdentityAuthority } from '../router';
import { handleBrowserRenewal } from '../../../handlers/browser-renewal';

vi.mock('../../../db/client', () => {
  const refused = new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_RENEWAL_CONTENT_DATABASE');
      },
    },
  );
  return { db: refused, dbRead: refused };
});
const contract = 'private-browser-renewal-v1' as const;
const rpcSecret = 'owned-renewal-real-http-private-service-key-6975';
const sourceSecret = 'owned-renewal-real-http-original-jwe-key-6975';
const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = requireWeb('next-auth/jwt') as {
  encode(input: { secret: string; maxAge: number; token: Record<string, unknown> }): Promise<string>;
  decode(input: { secret: string; token: string }): Promise<Record<string, unknown> | null>;
};
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let server: Server;
let origin: string;
let projectionId: string;
const qualification = () => ({
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
});
async function post(
  operation: BrowserRenewalCommand['operation'],
  payload: unknown,
  authorization = `Bearer ${rpcSecret}`,
) {
  const response = await fetch(`${origin}${BROWSER_RENEWAL_COMMAND_PATHS[operation]}`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({
      browserRenewalProtocolVersion: 1,
      requestId: randomUUID(),
      issuedAt: Date.now(),
      operation,
      payload,
    }),
  });
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('no-store');
  return { status: response.status, body: (await response.json()) as unknown };
}
function prepared(body: unknown) {
  const reply = browserRenewalReplySchema.parse(body);
  if (reply.outcome !== 'prepared') throw new Error(`Owned HTTP renewal preparation refused: ${reply.outcome}`);
  return reply;
}
async function source(
  selected: 'current-store' | 'better-auth',
  kind: 'legacy-jwe' | 'canonical-token',
  unknownAge = false,
) {
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
  const database = await getCredentialDatabase(contract);
  expect(await executeFirstRow(database, sql`SELECT current_user AS role, session_user AS "sessionRole"`)).toEqual({
    role: 'boardsesh_identity_writer',
    sessionRole: 'boardsesh_identity_writer',
  });
  const driver = await createProviderSecurityDriver({
    database,
    runtime: {
      qualification: qualification(),
      legacySecret: sourceSecret,
      methods: {
        configuredProviders: ['google', 'apple'],
        googleAudience: 'owned-renewal-google',
        googleReauthenticationEnabled: false,
      },
    },
  });
  const owner = await driver.actor(selected, kind, { password: false, unknownAge });
  const credential =
    kind === 'legacy-jwe'
      ? { kind: 'legacy-jwe' as const, credential: owner.actor.credential }
      : { kind: 'canonical-token' as const, token: owner.actor.credential };
  return {
    owner,
    database,
    payload: {
      bindingToken: owner.actor.browserBindingToken,
      actor: { version: owner.actor.browserVersion, credential },
      nonceHash: createHash('sha256').update(randomUUID()).digest('hex'),
    },
  };
}
async function candidate(
  current: Awaited<ReturnType<typeof source>>,
  result: Extract<BrowserRenewalReply, { outcome: 'prepared' }>,
) {
  if (current.payload.actor.credential.kind === 'canonical-token') return current.payload.actor.credential;
  const proof = result.preparation.sourceCredentialProof;
  const milliseconds = Math.floor(Date.now() / 1000) * 1000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(milliseconds);
  let credential: string;
  try {
    credential = await jwt.encode({
      secret: sourceSecret,
      maxAge: Date.parse(result.preparation.targetExpiresAt) / 1000 - milliseconds / 1000,
      token: {
        sub: proof.userId,
        authSessionId: proof.authSessionId,
        gen: proof.generation,
        ...(proof.authenticatedAt ? { auth_time: Date.parse(proof.authenticatedAt) / 1000, link_guarded: true } : {}),
        ...(proof.requiresAccountCutoff ? { legacy_no_sid: true } : {}),
      },
    });
  } finally {
    clock.mockRestore();
  }
  expect((await jwt.decode({ secret: sourceSecret, token: credential }))?.exp).toBe(
    Date.parse(result.preparation.targetExpiresAt) / 1000,
  );
  return { kind: 'legacy-jwe' as const, credential };
}
async function snapshot() {
  return {
    sessions: await environment.ownerDatabase.select().from(authSession).orderBy(authSession.id),
    bindings: await environment.ownerDatabase.select().from(authBrowserBindings).orderBy(authBrowserBindings.id),
    renewals: await environment.ownerDatabase
      .select()
      .from(authBrowserRenewals)
      .orderBy(authBrowserRenewals.operationHash),
  };
}
describe('ordinary renewal through actual restricted LOGIN and mounted private HTTP', () => {
  beforeAll(async () => {
    environment = await createCredentialWriterEnvironment(contract);
    await environment.ownerDatabase.transaction(async (transaction) => {
      const [manifest] = await transaction
        .select()
        .from(authEmailProjection)
        .where(eq(authEmailProjection.isCurrent, true));
      if (manifest) {
        if (manifest.phase !== 'enforced') throw new Error('Owned renewal requires enforced projection');
        projectionId = manifest.projectionId;
      } else {
        projectionId = randomUUID();
        await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
        await transaction.update(authEmailProjection).set({ phase: 'enforced' });
      }
    });
    server = createServer((request, response) => {
      void handleBrowserRenewal(request, response).catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned renewal listener absent');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    for (const [name, contents] of Object.entries({
      DATABASE_URL: environment.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: contract,
      CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
      CURRENT_STORE_BROWSER_RENEWAL_MODE: 'backend-staging',
      CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
      CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
      CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
      CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-renewal-different-deleted-email-key-6975',
      NEXTAUTH_SECRET: sourceSecret,
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      AUTH_IDENTITY_MIRROR: 'on',
      DEBUG_SQL: 'false',
    }))
      vi.stubEnv(name, contents);
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
    for (const kind of ['legacy-jwe', 'canonical-token'] as const)
      it.each([false, true])(
        `${selected}/${kind} original unknown age=%s: rolls lifetime and ACKs without writes`,
        async (unknownAge) => {
          const current = await source(selected, kind, unknownAge);
          const before = await snapshot();
          const preparation = await post('prepare', current.payload);
          expect(preparation.status).toBe(200);
          const result = prepared(preparation.body);
          expect(result.preparation.sourceCredentialProof).toMatchObject({
            userId: current.owner.userId,
            authSessionId: current.owner.sid,
            generation: 0,
            authenticatedAt: current.owner.authenticatedAt?.toISOString() ?? null,
          });
          expect(Date.parse(result.preparation.targetExpiresAt)).toBe(
            (Math.floor(Date.parse(result.preparation.preparedAt) / 1000) + 30 * 86400) * 1000,
          );
          expect((await snapshot()).sessions).toEqual(before.sessions);
          expect((await snapshot()).bindings).toEqual(before.bindings);
          const bound = {
            ...current.payload,
            operationToken: result.operationToken,
            preparationToken: result.preparationToken,
            preparation: result.preparation,
            candidate: await candidate(current, result),
          };
          const completed = await post('finalize', bound);
          expect(completed.status).toBe(200);
          expect(browserRenewalReplySchema.parse(completed.body)).toMatchObject({
            outcome: 'completed',
            cursor: result.preparation.futureBrowserCursor,
            credentialProof: result.preparation.sourceCredentialProof,
            credentialExpiresAt: result.preparation.targetExpiresAt,
          });
          const after = await snapshot();
          const acknowledged = await post('acknowledge', bound);
          expect(acknowledged.status).toBe(200);
          expect(browserRenewalReplySchema.parse(acknowledged.body).outcome).toBe('completed');
          expect(await snapshot()).toEqual(after);
          const [binding] = after.bindings.filter((stored) => stored.id === result.preparation.browserCursor.bindingId);
          expect(binding).toMatchObject({
            userId: current.owner.userId,
            authSessionId: current.owner.sid,
            generation: 0,
            version: current.payload.actor.version + 1,
            authenticatedAt: current.owner.authenticatedAt,
          });
          expect(binding.expiresAt.toISOString()).toBe(result.preparation.futureBrowserCursor.bindingExpiresAt);
          if (kind === 'canonical-token') {
            const [oldSession] = before.sessions.filter((stored) => stored.id === current.owner.sid);
            const [newSession] = after.sessions.filter((stored) => stored.id === current.owner.sid);
            expect(newSession).toMatchObject({
              token: oldSession.token,
              createdAt: oldSession.createdAt,
              originalAuthenticatedAt: oldSession.originalAuthenticatedAt,
              revocationGeneration: oldSession.revocationGeneration,
            });
            expect(newSession.expiresAt.toISOString()).toBe(result.preparation.targetExpiresAt);
          }
        },
      );
  it('keeps old profiles exact and denies mutation of frozen preparation columns', async () => {
    expect(
      await qualifyCredentialWriter(environment.writer, {
        expectedRole: 'boardsesh_identity_writer',
        expectedDatabase: environment.databaseName,
        contract,
      }),
    ).toMatchObject({ contract, role: 'boardsesh_identity_writer', sessionRole: 'boardsesh_identity_writer' });
    for (const old of [
      'private-web-v1',
      'private-browser-v1',
      'private-provider-v1',
      'private-first-password-v1',
      'private-native-handoff-v1',
    ] as const)
      await expect(
        qualifyCredentialWriter(environment.writer, {
          expectedRole: 'boardsesh_identity_writer',
          expectedDatabase: environment.databaseName,
          contract: old,
        }),
      ).rejects.toThrow();
    await expect(environment.writer`UPDATE auth_browser_renewals SET metadata_hash='forged'`).rejects.toMatchObject({
      code: '42501',
    });
    await expect(environment.writer`DELETE FROM auth_browser_renewals`).rejects.toMatchObject({ code: '42501' });
    await expect(environment.writer`ALTER TABLE auth_browser_renewals ADD COLUMN forged text`).rejects.toMatchObject({
      code: '42501',
    });
  });
  it('refuses renewal polling while a real account-change intent remains live', async () => {
    const current = await source('current-store', 'legacy-jwe');
    expect(
      await beginBrowserIntent(current.database, qualification(), current.payload.bindingToken, {
        operation: 'login',
        expectedVersion: current.payload.actor.version,
        presented: { version: current.payload.actor.version, credential: current.owner.credential },
      }),
    ).toMatchObject({ status: 'prepared' });
    const before = await snapshot();
    expect((await post('prepare', current.payload)).status).toBe(409);
    expect(await snapshot()).toEqual(before);
  });
  it('rejects wrong service authentication before changing any session or selection', async () => {
    const current = await source('better-auth', 'canonical-token');
    const before = await snapshot();
    expect((await post('prepare', current.payload, 'Bearer unrelated')).status).toBe(401);
    expect(await snapshot()).toEqual(before);
  });
  it('rolls back earlier session and binding writes when a completion-column grant disappears', async () => {
    const current = await source('better-auth', 'canonical-token');
    const result = prepared((await post('prepare', current.payload)).body);
    const bound = {
      ...current.payload,
      operationToken: result.operationToken,
      preparationToken: result.preparationToken,
      preparation: result.preparation,
      candidate: await candidate(current, result),
    };
    const before = await snapshot();
    await environment.owner`REVOKE UPDATE (candidate_hash) ON auth_browser_renewals FROM boardsesh_identity_writer`;
    try {
      expect((await post('finalize', bound)).status).toBe(503);
      expect(await snapshot()).toEqual(before);
    } finally {
      await environment.owner`GRANT UPDATE (candidate_hash) ON auth_browser_renewals TO boardsesh_identity_writer`;
    }
    expect((await post('finalize', bound)).status).toBe(200);
  });
});
