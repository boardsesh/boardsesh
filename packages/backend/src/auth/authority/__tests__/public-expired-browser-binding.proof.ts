import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { executeFirstRow } from '@boardsesh/db/client';
import {
  authBrowserBindings,
  authEmailProjection,
  authSession,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import {
  EXPIRED_BROWSER_BINDING_COMMAND_PATHS,
  type ExpiredBrowserBindingPreparation,
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

import { BROWSER_BINDING_COMMAND_PATHS } from '@boardsesh/auth-protocol/browser-binding-v1';
import {
  EXPIRED_BROWSER_BINDING_BROWSER_PATHS,
  expiredBrowserBindingBrowserPreparationReplySchema,
} from '@boardsesh/auth-protocol/expired-browser-binding-browser-v1';
import { handleBrowserBinding } from '../../../handlers/browser-binding';
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
vi.doMock(requireWeb.resolve('server-only'), () => ({}));
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
    users: hash(JSON.stringify(await environment.ownerDatabase.select().from(users).orderBy(users.id))),
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

// Real production web modules, loaded at runtime to respect each package's rootDir.
async function loadWebModule<Exports>(name: string): Promise<Exports> {
  const location = new URL(`../../../../../web/app/lib/auth/${name}`, import.meta.url);
  return (await import(location.href)) as Exports;
}
type Broker = {
  prepare(request: Request): Promise<Response>;
  commit(request: Request): Promise<Response>;
  confirm(request: Request): Promise<Response>;
};
type BrokerModule = { createExpiredBrowserBindingBrowserBroker(options: object): Broker };
type BindingModule = { createBrowserBindingCommandClient(options: object): unknown };
type CommandModule = { createExpiredBrowserBindingCommandClient(options: object): unknown };
type SelectionModule = { readPresentedBrowserSelection(header: string | null, options: object): Promise<unknown> };
type CarrierModule = {
  readExpiredBrowserBindingCarrier(
    header: string,
    operationKey: string,
    secret: string,
    origin: string,
  ): {
    bindingToken: string;
    targetBindingToken: string;
    operationToken: string;
    preparation: ExpiredBrowserBindingPreparation;
  };
};
const publicOrigin = 'https://www.owned-expired-signin.example.test';
const correlationName = '__Host-boardsesh.browser-binding';
function applyCookies(jar: Map<string, string>, response: Response) {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';', 1)[0];
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator),
      content = pair.slice(separator + 1);
    if (content) jar.set(name, content);
    else jar.delete(name);
  }
}
async function publicFlow(bindingToken: string, loseReply = false) {
  const [brokerModule, bindingModule, commandModule, selectionModule, carrierModule] = await Promise.all([
    loadWebModule<BrokerModule>('expired-browser-binding-browser.server.ts'),
    loadWebModule<BindingModule>('browser-binding-command-client.server.ts'),
    loadWebModule<CommandModule>('expired-browser-binding-command-client.server.ts'),
    loadWebModule<SelectionModule>('presented-browser-selection.server.ts'),
    loadWebModule<CarrierModule>('expired-browser-binding-carrier.server.ts'),
  ]);
  const capturedEnvironment = {
    ...process.env,
    NODE_ENV: 'test',
    NEXTAUTH_URL: publicOrigin,
    NEXTAUTH_SECRET: sourceSecret,
    CURRENT_STORE_AUTH_BACKEND_ORIGIN: origin,
  };
  const trace: string[] = [];
  let dropped = false;
  const privateFetch: typeof fetch = async (input, options) => {
    const path = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname;
    trace.push(path);
    const response = await fetch(input, options);
    if (loseReply && !dropped && path === EXPIRED_BROWSER_BINDING_COMMAND_PATHS.finalize) {
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      dropped = true;
      throw new Error('OWNED_DURABLE_PRIVATE_REPLY_CONSUMED');
    }
    return response;
  };
  const browser = bindingModule.createBrowserBindingCommandClient({
    environment: capturedEnvironment,
    fetch: privateFetch,
  });
  const command = commandModule.createExpiredBrowserBindingCommandClient({
    environment: capturedEnvironment,
    fetch: privateFetch,
  });
  const broker = brokerModule.createExpiredBrowserBindingBrowserBroker({
    environment: capturedEnvironment,
    ready: () => true,
    readSelection: (header: string | null) =>
      selectionModule.readPresentedBrowserSelection(header, { environment: capturedEnvironment, client: browser }),
    clientFactory: () => command,
    bindingFactory: () => browser,
    rateLimit: () => false,
  });
  const jar = new Map<string, string>([[correlationName, bindingToken]]);
  const cookieHeader = () => [...jar].map(([name, content]) => `${name}=${content}`).join('; ');
  const request = (operation: keyof typeof EXPIRED_BROWSER_BINDING_BROWSER_PATHS, body: unknown) =>
    new Request(publicOrigin + EXPIRED_BROWSER_BINDING_BROWSER_PATHS[operation], {
      method: 'POST',
      headers: {
        host: new URL(publicOrigin).host,
        origin: publicOrigin,
        cookie: cookieHeader(),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  const response = await broker.prepare(request('prepare', {}));
  expect(response.status).toBe(200);
  const result = expiredBrowserBindingBrowserPreparationReplySchema.parse(await response.json());
  if (result.status !== 'prepared') throw new Error('Owned public custody was not prepared');
  const control = {
    operationKey: result.operationKey,
    sourceCursor: result.sourceCursor,
    targetCursor: result.targetCursor,
  };
  expect(response.headers.getSetCookie().every((cookie) => !cookie.startsWith('__Host-boardsesh.browser-proof.'))).toBe(
    true,
  );
  applyCookies(jar, response);
  expect(jar.get(correlationName)).toBe(bindingToken);
  const carrier = carrierModule.readExpiredBrowserBindingCarrier(
    cookieHeader(),
    control.operationKey,
    sourceSecret,
    publicOrigin,
  );
  expect(carrier.bindingToken).toBe(bindingToken);
  expect(hash(carrier.targetBindingToken)).toBe(control.targetCursor.bindingId);
  expect(JSON.stringify(result)).not.toContain(carrier.targetBindingToken);
  expect(JSON.stringify(result)).not.toContain(carrier.operationToken);
  return { broker, jar, control, request, carrier, trace, cookieHeader };
}
describe('public explicit sign-in custody to actual restricted LOGIN and mounted private HTTP', () => {
  beforeAll(async () => {
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
      const handler = Object.values(BROWSER_BINDING_COMMAND_PATHS).some((path) => path === request.url)
        ? handleBrowserBinding
        : handleExpiredBrowserBinding;
      void handler(request, response).catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned listener missing');
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
      beforeEach(() => {
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
        for (const kind of ['anonymous', 'legacy-jwe', 'canonical-token'] as const)
          it.each([false, true])(`${authority}/${kind}: actual custody, lost private reply=%s`, async (loseReply) => {
            const old = await binding(kind, authority);
            const [oldRow] = await environment.ownerDatabase
              .select()
              .from(authBrowserBindings)
              .where(eq(authBrowserBindings.id, hash(old.bindingToken)));
            const before = await snapshot();
            const flow = await publicFlow(old.bindingToken, loseReply);
            expect((await snapshot()).bindings).toBe(before.bindings);
            const initialFinalizers = finalizeRequests;
            const committed = await flow.broker.commit(flow.request('commit', flow.control));
            expect(committed.status).toBe(loseReply ? 503 : 200);
            if (loseReply) expect(committed.headers.getSetCookie()).toEqual([]);
            else applyCookies(flow.jar, committed);
            const durable = await snapshot();
            expect(durable.bindingRows).toBe(before.bindingRows + 1);
            expect(durable.sessions).toBe(before.sessions);
            expect(durable.users).toBe(before.users);
            if (loseReply) {
              expect(flow.jar.get(correlationName)).toBe(old.bindingToken);
              const recovered = await flow.broker.prepare(flow.request('prepare', {}));
              expect(recovered.status).toBe(200);
              expect(await recovered.clone().json()).toEqual({ status: 'ready', cursor: flow.control.targetCursor });
              applyCookies(flow.jar, recovered);
            }
            expect(flow.jar.get(correlationName)).toBe(flow.carrier.targetBindingToken);
            const confirmed = await flow.broker.confirm(flow.request('confirm', flow.control));
            expect(confirmed.status).toBe(200);
            applyCookies(flow.jar, confirmed);
            expect([...flow.jar.keys()].filter((name) => name.startsWith('__Host-boardsesh.expired-binding.'))).toEqual(
              [],
            );
            expect(finalizeRequests).toBe(initialFinalizers + 1);
            expect(flow.trace.filter((path) => path === EXPIRED_BROWSER_BINDING_COMMAND_PATHS.finalize)).toHaveLength(
              1,
            );
            expect(await snapshot()).toEqual(durable);
            expect(
              await environment.ownerDatabase
                .select()
                .from(authBrowserBindings)
                .where(eq(authBrowserBindings.id, oldRow.id)),
            ).toEqual([oldRow]);
            const [target] = await environment.ownerDatabase
              .select()
              .from(authBrowserBindings)
              .where(eq(authBrowserBindings.id, flow.control.targetCursor.bindingId));
            expect(target).toMatchObject({
              credentialKind: null,
              version: 0,
              intentRevision: 0,
              userId: null,
              authSessionId: null,
              generation: null,
            });
          });
      it('refuses stale A custody carrying actual current B before any physical finalizer', async () => {
        const old = await binding('canonical-token', 'current-store');
        const flow = await publicFlow(old.bindingToken);
        const current = await binding('anonymous', 'current-store', false);
        flow.jar.set(correlationName, current.bindingToken);
        const before = await snapshot();
        const count = finalizeRequests;
        const response = await flow.broker.commit(flow.request('commit', flow.control));
        // Inspect physical writes before the returned status.
        expect((await snapshot()).bindingRows).toBe(before.bindingRows);
        expect(response.status).toBe(409);
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(finalizeRequests).toBe(count);
        expect(await snapshot()).toEqual(before);
      });
      it('prebuilds whole target-cookie capacity before any physical finalizer', async () => {
        const old = await binding('anonymous', 'current-store');
        const flow = await publicFlow(old.bindingToken);
        flow.jar.set('unrelated', 'x'.repeat(8_000));
        const before = await snapshot();
        const count = finalizeRequests;
        const response = await flow.broker.commit(flow.request('commit', flow.control));
        expect((await snapshot()).bindingRows).toBe(before.bindingRows);
        expect(finalizeRequests).toBe(count);
        expect(response.status).toBe(503);
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(await snapshot()).toEqual(before);
      });
      it('cannot confirm physical anonymous target custody without the durable completed receipt', async () => {
        const old = await binding('anonymous', 'current-store');
        const flow = await publicFlow(old.bindingToken);
        await environment.ownerDatabase.insert(authBrowserBindings).values({
          id: flow.control.targetCursor.bindingId,
          createdAt: new Date(flow.carrier.preparation.preparedAt),
          expiresAt: new Date(flow.carrier.preparation.targetCursor.bindingExpiresAt),
        });
        flow.jar.set(correlationName, flow.carrier.targetBindingToken);
        const before = await snapshot();
        const count = finalizeRequests;
        const response = await flow.broker.confirm(flow.request('confirm', flow.control));
        expect(response.status).toBe(409);
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(finalizeRequests).toBe(count);
        expect(await snapshot()).toEqual(before);
      });
    });
});
