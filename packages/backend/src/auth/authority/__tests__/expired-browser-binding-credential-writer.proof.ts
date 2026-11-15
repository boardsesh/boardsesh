import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { executeFirstRow } from '@boardsesh/db/client';
import { qualifyCredentialWriter } from '@boardsesh/db/credential-writer-acl';
import {
  authBrowserBindings,
  authEmailProjection,
  authSession,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import {
  EXPIRED_BROWSER_BINDING_COMMAND_PATHS,
  expiredBrowserBindingReplySchema,
  type ExpiredBrowserBindingCommand,
} from '@boardsesh/auth-protocol/expired-browser-binding-v1';
import {
  createCredentialWriterEnvironment,
  grantOwnedCredentialWriterCapabilities,
} from './fixtures/credential-writer-environment';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { closeCredentialDatabase, getCredentialDatabase } from '../../credential-database';
import {
  beginBrowserIntent,
  commitBrowserLogin,
  createUnpublishedBrowserBinding,
  type BrowserSelectionCredential,
} from '../browser-binding';
import { switchIdentityAuthority } from '../router';
import { handleExpiredBrowserBinding } from '../../../handlers/expired-browser-binding';

vi.mock('../../../db/client', () => {
  const forbidden = new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_RETIREMENT_CONTENT_DATABASE');
      },
    },
  );
  return { db: forbidden, dbRead: forbidden };
});
const hash = (input: string) => createHash('sha256').update(input).digest('hex');
const rpcSecret = 'owned-expired-binding-service-secret-6975';
const sourceSecret = 'owned-expired-binding-source-secret-6975';
const proofContracts = ['private-provider-v1', 'private-browser-renewal-v1'] as const;
const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = requireWeb('next-auth/jwt') as {
  encode(input: { secret: string; maxAge: number; token: Record<string, unknown> }): Promise<string>;
};
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let server: Server;
let origin: string;
let projectionId: string;
let finalizeRequests = 0;
const qualification = () => ({
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
});
async function post(operation: ExpiredBrowserBindingCommand['operation'], payload: unknown, loseReply = false) {
  const response = await fetch(`${origin}${EXPIRED_BROWSER_BINDING_COMMAND_PATHS[operation]}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      expiredBrowserBindingProtocolVersion: 1,
      requestId: randomUUID(),
      issuedAt: Date.now(),
      operation,
      payload,
    }),
  });
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body: unknown = await response.json();
  if (loseReply) throw new Error('Owned actual HTTP reply consumed before caller received it');
  return { status: response.status, body: expiredBrowserBindingReplySchema.parse(body) };
}
function prepared(result: Awaited<ReturnType<typeof post>>) {
  expect(result.status).toBe(200);
  if (result.body.outcome !== 'prepared') throw new Error('Owned restricted preparation refused');
  return result.body;
}
function payload(bindingToken: string, result: ReturnType<typeof prepared>) {
  return {
    bindingToken,
    operationToken: result.operationToken,
    targetBindingToken: result.targetBindingToken,
    preparation: result.preparation,
  };
}
async function snapshot() {
  const bindings = await environment.ownerDatabase.select().from(authBrowserBindings).orderBy(authBrowserBindings.id);
  const receipts = await environment.ownerDatabase
    .select()
    .from(verificationTokens)
    .orderBy(verificationTokens.identifier, verificationTokens.token);
  const sessions = await environment.ownerDatabase.select().from(authSession).orderBy(authSession.id);
  return {
    bindings: hash(JSON.stringify(bindings)),
    receipts: hash(JSON.stringify(receipts)),
    sessions: hash(JSON.stringify(sessions)),
    bindingRows: bindings.length,
  };
}
async function binding(
  kind: 'anonymous' | 'legacy-jwe' | 'canonical-token',
  selected: 'current-store' | 'better-auth',
  expired = true,
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
  const database = await getCredentialDatabase('private-browser-v1');
  expect(await getCredentialDatabase('private-web-v1')).toBe(database);
  expect(await executeFirstRow(database, sql`SELECT current_user AS role, session_user AS "sessionRole"`)).toEqual({
    role: 'boardsesh_identity_writer',
    sessionRole: 'boardsesh_identity_writer',
  });
  const created = await createUnpublishedBrowserBinding(database, qualification());
  if (created.status !== 'created') throw new Error('Owned restricted binding failed');
  let credential: BrowserSelectionCredential['credential'] | undefined;
  if (kind !== 'anonymous') {
    const userId = randomUUID();
    const sessionId = randomUUID();
    await environment.ownerDatabase.insert(users).values({ id: userId, email: `${userId}@owned-retirement.test` });
    if (kind === 'canonical-token') {
      const token = randomBytes(32).toString('base64url');
      await environment.ownerDatabase.insert(authSession).values({
        id: sessionId,
        token,
        userId,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        revocationGeneration: 0,
      });
      credential = { kind, token };
    } else
      credential = {
        kind,
        secret: sourceSecret,
        credential: await jwt.encode({
          secret: sourceSecret,
          maxAge: 3_600,
          token: { sub: userId, authSessionId: sessionId, gen: 0 },
        }),
      };
    const intent = await beginBrowserIntent(database, qualification(), created.token, {
      operation: 'login',
      expectedVersion: 0,
    });
    if (intent.status !== 'prepared') throw new Error('Owned restricted intent failed');
    expect(
      (await commitBrowserLogin(database, qualification(), created.token, intent.intentToken, credential)).status,
    ).toBe('committed');
  }
  if (expired)
    await environment.ownerDatabase
      .update(authBrowserBindings)
      .set({ createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(authBrowserBindings.id, hash(created.token)));
  return { bindingToken: created.token, database, credential };
}
describe('expired-only flow through actual restricted LOGIN and mounted private HTTP', () => {
  beforeAll(async () => {
    // This fixture authenticates the complete canonical journal. Profiles1/2's
    // separate historical fixture remains immutable and is not relaxed here.
    environment = await createCredentialWriterEnvironment('private-browser-renewal-v1');
    await environment.ownerDatabase.transaction(async (transaction) => {
      const [manifest] = await transaction
        .select()
        .from(authEmailProjection)
        .where(eq(authEmailProjection.isCurrent, true));
      if (manifest) {
        if (manifest.phase !== 'enforced') throw new Error('Owned canonical projection must be enforced');
        projectionId = manifest.projectionId;
      } else {
        projectionId = randomUUID();
        await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
        await transaction.update(authEmailProjection).set({ phase: 'enforced' });
      }
    });
    server = createServer((request, response) => {
      if (request.url === EXPIRED_BROWSER_BINDING_COMMAND_PATHS.finalize) finalizeRequests += 1;
      void handleExpiredBrowserBinding(request, response).catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned restricted listener missing');
    origin = `http://127.0.0.1:${address.port}`;
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
  for (const contract of proofContracts)
    describe(contract, () => {
      beforeAll(async () => {
        await grantOwnedCredentialWriterCapabilities(environment.owner, contract);
      });
      beforeEach(async () => {
        for (const [name, content] of Object.entries({
          DATABASE_URL: environment.legacyUrl,
          AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
          AUTH_IDENTITY_DATABASE_CONTRACT: contract,
          CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
          CURRENT_STORE_EXPIRED_BROWSER_BINDING_MODE: 'backend-staging',
          CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
          CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
          CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
          CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-retirement-deleted-email-key-distinct',
          NEXTAUTH_SECRET: sourceSecret,
          AUTH_CUTOFF_ENFORCEMENT: 'enforce',
          DEBUG_SQL: 'false',
        }))
          vi.stubEnv(name, content);
      });
      for (const authority of ['current-store', 'better-auth'] as const)
        it.each(['anonymous', 'legacy-jwe', 'canonical-token'] as const)(
          `${authority}/%s: creates only anonymous v0 and recovers a lost reply with read-only ACK`,
          async (kind) => {
            const old = await binding(kind, authority);
            const before = await snapshot();
            const result = prepared(
              await post('prepare', { bindingToken: old.bindingToken, nonceHash: 'a'.repeat(64) }),
            );
            expect((await snapshot()).bindings).toBe(before.bindings);
            const bound = payload(old.bindingToken, result);
            const beforeFinalize = finalizeRequests;
            await expect(post('finalize', bound, true)).rejects.toThrow(
              'Owned actual HTTP reply consumed before caller received it',
            );
            const completed = await snapshot();
            expect(completed.bindingRows).toBe(before.bindingRows + 1);
            expect(completed.sessions).toBe(before.sessions);
            expect((await post('acknowledge', bound)).status).toBe(200);
            expect(finalizeRequests).toBe(beforeFinalize + 1);
            expect((await post('finalize', bound)).status).toBe(409);
            expect(await snapshot()).toEqual(completed);
            const rights = await executeFirstRow<{
              browserDelete: boolean;
              userDelete: boolean;
              receiptUpdate: boolean;
            }>(
              old.database,
              sql`SELECT has_table_privilege(current_user,'auth_browser_bindings','DELETE') AS "browserDelete",has_table_privilege(current_user,'users','DELETE') AS "userDelete",has_table_privilege(current_user,'"verificationTokens"','UPDATE') AS "receiptUpdate"`,
            );
            expect(rights).toEqual({ browserDelete: false, userDelete: false, receiptUpdate: true });
          },
        );
      it('refuses a live selected binding with missing proof without writes', async () => {
        const old = await binding('canonical-token', 'current-store', false);
        const before = await snapshot();
        expect((await post('prepare', { bindingToken: old.bindingToken, nonceHash: 'a'.repeat(64) })).status).toBe(401);
        expect(await snapshot()).toEqual(before);
      });
      it('refuses the old profile1 instead of opening another pool or a content fallback', async () => {
        const old = await binding('anonymous', 'current-store');
        await closeCredentialDatabase();
        vi.stubEnv('AUTH_IDENTITY_DATABASE_CONTRACT', 'private-web-v1');
        const before = await snapshot();
        expect((await post('prepare', { bindingToken: old.bindingToken, nonceHash: 'a'.repeat(64) })).status).toBe(503);
        expect(await snapshot()).toEqual(before);
        await expect(
          qualifyCredentialWriter(environment.writer, {
            expectedRole: 'boardsesh_identity_writer',
            expectedDatabase: environment.databaseName,
            contract: 'private-web-v1',
          }),
        ).rejects.toThrow();
      });
      it('rolls back target insertion when cached qualification loses only receipt UPDATE, then permits the exact pending plan after restoration', async () => {
        const old = await binding('canonical-token', 'current-store');
        const result = prepared(await post('prepare', { bindingToken: old.bindingToken, nonceHash: 'a'.repeat(64) }));
        const before = await snapshot();
        await environment.owner`REVOKE UPDATE ON TABLE "verificationTokens" FROM boardsesh_identity_writer`;
        try {
          expect((await post('finalize', payload(old.bindingToken, result))).status).toBe(503);
          expect(await snapshot()).toEqual(before);
        } finally {
          await grantOwnedCredentialWriterCapabilities(environment.owner, contract);
        }
        expect((await post('finalize', payload(old.bindingToken, result))).status).toBe(200);
      });
      it('cannot ACK a target whose actual new binding is independently anonymous before durable completion', async () => {
        const old = await binding('anonymous', 'current-store');
        const result = prepared(await post('prepare', { bindingToken: old.bindingToken, nonceHash: 'a'.repeat(64) }));
        await environment.ownerDatabase.insert(authBrowserBindings).values({
          id: result.preparation.targetCursor.bindingId,
          createdAt: new Date(result.preparation.preparedAt),
          expiresAt: new Date(result.preparation.targetCursor.bindingExpiresAt),
        });
        const before = await snapshot();
        expect((await post('acknowledge', payload(old.bindingToken, result))).status).toBe(409);
        expect(await snapshot()).toEqual(before);
      });
      it('cannot ACK or overwrite a target that has selected another actual account', async () => {
        const old = await binding('anonymous', 'current-store');
        const result = prepared(await post('prepare', { bindingToken: old.bindingToken, nonceHash: 'a'.repeat(64) }));
        expect((await post('finalize', payload(old.bindingToken, result))).status).toBe(200);
        const other = await binding('canonical-token', 'current-store', false);
        if (!other.credential) throw new Error('Owned different-account credential missing');
        const intent = await beginBrowserIntent(old.database, qualification(), result.targetBindingToken, {
          operation: 'login',
          expectedVersion: 0,
        });
        if (intent.status !== 'prepared') throw new Error('Owned target intent missing');
        expect(
          (
            await commitBrowserLogin(
              old.database,
              qualification(),
              result.targetBindingToken,
              intent.intentToken,
              other.credential,
            )
          ).status,
        ).toBe('committed');
        const before = await snapshot();
        expect((await post('acknowledge', payload(old.bindingToken, result))).status).toBe(409);
        expect(await snapshot()).toEqual(before);
      });
      it.each(['created_at', 'expires_at'] as const)(
        'refuses exact target %s drift below a millisecond on the actual writer',
        async (column) => {
          const old = await binding('anonymous', 'current-store');
          const result = prepared(await post('prepare', { bindingToken: old.bindingToken, nonceHash: 'a'.repeat(64) }));
          const bound = payload(old.bindingToken, result);
          expect((await post('finalize', bound)).status).toBe(200);
          await environment.ownerDatabase.execute(
            sql`UPDATE ${authBrowserBindings} SET ${sql.identifier(column)}=${sql.identifier(column)}+interval '1 microsecond' WHERE id=${result.preparation.targetCursor.bindingId}`,
          );
          const before = await snapshot();
          expect((await post('acknowledge', bound)).status).toBe(409);
          expect(await snapshot()).toEqual(before);
        },
      );
    });
});
