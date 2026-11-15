import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { hash } from 'bcryptjs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, like, lte, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { executeFirstRow } from '@boardsesh/db/client';
import * as schema from '@boardsesh/db/schema';
import {
  authBrowserBindings,
  authEmailProjection,
  authSession,
  authSubjectCutoffs,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import {
  BROWSER_PASSWORD_COMMAND_PATHS,
  browserPasswordReplySchema,
  type BrowserPasswordCommand,
  type BrowserPasswordSource,
} from '@boardsesh/auth-protocol/browser-password-v1';
import { createCredentialWriterEnvironment, ownedCredentialProofUrl } from './fixtures/credential-writer-environment';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { captureIdentityAuthority, switchIdentityAuthority } from '../router';
import { bindIdentityAuthority } from '../identity-authority';
import { closeCredentialDatabase, getCredentialDatabase } from '../../credential-database';
import { beginBrowserIntent, commitBrowserLogin, createUnpublishedBrowserBinding } from '../browser-binding';
import * as bindingModule from '../browser-binding';
import * as passwordModule from '../../current-store/password-identity';
import { authenticateWebPassword } from '../../current-store/web-password';
import { handleBrowserPassword } from '../../../handlers/browser-password';
import { BROWSER_PASSWORD_RECEIPT_PREFIX } from '../browser-password-policy';
import { deleteExpiredBrowserPasswordReceipts } from '../browser-password-maintenance';

vi.mock('../../../db/client', () => {
  const forbidden = new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_PASSWORD_CONTENT_DATABASE');
      },
    },
  );
  return { db: forbidden, dbRead: forbidden };
});
const webRequire = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = webRequire('next-auth/jwt') as {
  encode(input: { secret: string; maxAge: number; token: Record<string, unknown> }): Promise<string>;
};
const readerSecret = 'owned-browser-password-proof-reader-secret';
const rpcSecret = 'owned-browser-password-proof-private-rpc-secret';
const plainPassword = '  unchanged\u0000密码  ';
const digest = (input: string) => createHash('sha256').update(input).digest('hex');
const opaque = () => randomBytes(32).toString('base64url');
let owner: postgres.Sql, ownerDatabase: ReturnType<typeof drizzle<typeof schema>>, server: Server, origin: string;
let projectionId: string,
  passwordHash: string,
  finalizeRequests = 0;
let ownerUrl: URL;
let closeOwner: (() => Promise<void>) | undefined;
const qualification = () => ({
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
});
const database = () => getCredentialDatabase('private-provider-v1');
async function post(operation: BrowserPasswordCommand['operation'], payload: unknown) {
  const response = await fetch(origin + BROWSER_PASSWORD_COMMAND_PATHS[operation], {
    method: 'POST',
    headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      browserPasswordProtocolVersion: 1,
      requestId: randomUUID(),
      issuedAt: Date.now(),
      operation,
      payload,
    }),
  });
  expect(response.headers.get('set-cookie')).toBeNull();
  const body: unknown = await response.json();
  return { status: response.status, body: browserPasswordReplySchema.parse(body) };
}
function prepared(reply: Awaited<ReturnType<typeof post>>) {
  expect(reply.status).toBe(200);
  if (reply.body.outcome !== 'prepared') throw new Error(`Owned password preparation failed: ${reply.body.outcome}`);
  return reply.body;
}
async function setAuthority(selected: 'current-store' | 'better-auth') {
  await ownerDatabase.transaction(async (transaction) => {
    const [manifest] = await transaction
      .select()
      .from(authEmailProjection)
      .where(eq(authEmailProjection.isCurrent, true));
    if (!manifest || manifest.phase !== 'enforced')
      throw new Error('Owned clone must have an enforced canonical projection');
    if (manifest.writerAuthority !== selected)
      await switchIdentityAuthority(transaction, {
        projectionId,
        epoch: manifest.writerEpoch,
        from: manifest.writerAuthority,
        to: selected,
      });
  });
}
async function setup(
  kind: 'legacy-jwe' | 'canonical-token',
  selected: boolean,
  authority: 'current-store' | 'better-auth',
  sameUser = false,
  limits: { bindingMs?: number; sourceSeconds?: number; verified?: boolean } = {},
) {
  await setAuthority(authority);
  const targetId = randomUUID(),
    email = `${targetId}@owned-password.test`;
  await ownerDatabase
    .insert(users)
    .values({ id: targetId, email, emailVerified: limits.verified === false ? null : new Date() });
  await ownerDatabase.transaction(async (transaction) => {
    const receipt = await captureIdentityAuthority(transaction, qualification());
    await bindIdentityAuthority(transaction, receipt).insertPassword(targetId, passwordHash, 0);
  });
  const writer = await database();
  const created = await createUnpublishedBrowserBinding(
    writer,
    qualification(),
    new Date(Date.now() + (limits.bindingMs ?? 86_400_000)),
  );
  if (created.status !== 'created') throw new Error('Owned password binding creation failed');
  let source: BrowserPasswordSource = { state: 'anonymous', bindingToken: created.token, expectedVersion: 0 };
  let sourceId: string | null = null;
  if (selected) {
    sourceId = sameUser ? targetId : randomUUID();
    if (!sameUser)
      await ownerDatabase.insert(users).values({ id: sourceId, email: `${sourceId}@owned-password-source.test` });
    const sid = randomUUID(),
      token = opaque();
    const credential =
      kind === 'canonical-token'
        ? { kind, token }
        : {
            kind,
            credential: await jwt.encode({
              secret: readerSecret,
              maxAge: limits.sourceSeconds ?? 3_600,
              token: { sub: sourceId, authSessionId: sid, gen: 0 },
            }),
            secret: readerSecret,
          };
    if (kind === 'canonical-token')
      await ownerDatabase.insert(authSession).values({
        id: sid,
        userId: sourceId,
        token,
        expiresAt: new Date(Date.now() + (limits.sourceSeconds ?? 3_600) * 1_000),
        updatedAt: new Date(),
        revocationGeneration: 0,
      });
    const intent = await beginBrowserIntent(writer, qualification(), created.token, {
      operation: 'login',
      expectedVersion: 0,
    });
    if (intent.status !== 'prepared') throw new Error('Owned initial selection intent failed');
    expect(
      (await commitBrowserLogin(writer, qualification(), created.token, intent.intentToken, credential)).status,
    ).toBe('committed');
    source = {
      state: 'selected',
      bindingToken: created.token,
      expectedVersion: 1,
      actor: {
        version: 1,
        credential:
          credential.kind === 'canonical-token'
            ? credential
            : { kind: credential.kind, credential: credential.credential },
      },
    };
  }
  const before = (
    await ownerDatabase
      .select()
      .from(authBrowserBindings)
      .where(eq(authBrowserBindings.id, digest(created.token)))
  )[0];
  return { source, sourceId, targetId, email, kind, before };
}
async function prepare(current: Awaited<ReturnType<typeof setup>>, password = plainPassword) {
  return prepared(
    await post('prepare', {
      source: current.source,
      email: current.email,
      password,
      credentialKind: current.kind,
      nonceHash: 'e'.repeat(64),
    }),
  );
}
async function bound(current: Awaited<ReturnType<typeof setup>>, reply: ReturnType<typeof prepared>) {
  let candidate: Extract<BrowserPasswordCommand, { operation: 'finalize' }>['payload']['candidate'];
  if (current.kind === 'canonical-token') {
    if (!reply.proposedCanonicalToken) throw new Error('Owned proposed token missing');
    candidate = { kind: current.kind, token: reply.proposedCanonicalToken };
  } else {
    const proof = reply.preparation.credentialProof;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(proof.authenticatedAt));
    let credential: string;
    try {
      credential = await jwt.encode({
        secret: readerSecret,
        maxAge: 30 * 86_400,
        token: {
          sub: proof.userId,
          authSessionId: proof.authSessionId,
          gen: proof.generation,
          auth_time: Date.parse(proof.authenticatedAt) / 1_000,
          link_guarded: true,
        },
      });
    } finally {
      clock.mockRestore();
    }
    candidate = { kind: current.kind, credential };
  }
  return {
    source: current.source,
    operationToken: reply.operationToken,
    browserIntentToken: reply.browserIntentToken,
    preparation: reply.preparation,
    candidate,
  };
}
async function snapshot() {
  return digest(
    JSON.stringify({
      bindings: await ownerDatabase.select().from(authBrowserBindings).orderBy(authBrowserBindings.id),
      sessions: await ownerDatabase.select().from(authSession).orderBy(authSession.id),
      receipts: await ownerDatabase
        .select()
        .from(verificationTokens)
        .orderBy(verificationTokens.identifier, verificationTokens.token),
    }),
  );
}
for (const contract of ['private-provider-v1', 'private-browser-renewal-v1'] as const)
  describe(`password publication through actual restricted LOGIN, verifier and private HTTP / ${contract}`, () => {
    beforeAll(async () => {
      const canonicalTarget = ownedCredentialProofUrl();
      const ownedCi =
        ['1', 'true'].includes(process.env.CI ?? '') &&
        process.env.GITHUB_ACTIONS === 'true' &&
        ['127.0.0.1', 'localhost'].includes(canonicalTarget.hostname) &&
        canonicalTarget.port === '5432' &&
        canonicalTarget.pathname === '/epic6975_credential_ci';
      const proofUrl = ownedCi
        ? canonicalTarget.toString()
        : contract === 'private-provider-v1'
          ? process.env.BROWSER_PASSWORD_PROFILE3_DATABASE_URL
          : process.env.CREDENTIAL_WRITER_PROOF_DATABASE_URL;
      if (!proofUrl) throw new Error('OWNED_BROWSER_PASSWORD_PROFILE_DATABASE_REQUIRED');
      ownerUrl = ownedCredentialProofUrl(proofUrl);
      if (ownedCi) {
        // Only this disposable CI target may select exact profiles serially.
        // Actual getCredentialDatabase qualification still runs for every case.
        const fixture = await createCredentialWriterEnvironment(contract);
        owner = fixture.owner;
        ownerDatabase = fixture.ownerDatabase;
        closeOwner = fixture.close;
      } else {
        // Local55480 is always root-prepared: no fixture creator or grant/role DDL.
        owner = postgres(ownerUrl.toString(), { max: 2, onnotice: () => undefined });
        ownerDatabase = drizzle(owner, { schema, logger: false });
        closeOwner = () => owner.end({ timeout: 5 });
      }
      await ownerDatabase.transaction(async (transaction) => {
        const [manifest] = await transaction
          .select()
          .from(authEmailProjection)
          .where(eq(authEmailProjection.isCurrent, true));
        if (!manifest) {
          if (!ownedCi) throw new Error('Owned clone canonical manifest required');
          projectionId = randomUUID();
          await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
          await transaction
            .update(authEmailProjection)
            .set({ phase: 'enforced' })
            .where(eq(authEmailProjection.isCurrent, true));
        } else {
          if (manifest.phase !== 'enforced') throw new Error('Owned canonical fixture prerequisite failed');
          projectionId = manifest.projectionId;
        }
        // Verify epoch, authority and the exact accepted normalizer under the gate.
        await captureIdentityAuthority(transaction, qualification());
      });
      passwordHash = await hash(plainPassword, 4);
      server = createServer((request, response) => {
        if (request.url === BROWSER_PASSWORD_COMMAND_PATHS.finalize) finalizeRequests++;
        void handleBrowserPassword(request, response).catch(() => {
          response.writeHead(500);
          response.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Owned password listener unavailable');
      origin = `http://127.0.0.1:${address.port}`;
    });
    beforeEach(() => {
      const writerUrl = new URL(ownerUrl),
        contentUrl = new URL(ownerUrl);
      writerUrl.username = 'boardsesh_identity_writer';
      writerUrl.password = 'epic6975-owned-credential-writer-only';
      contentUrl.username = 'boardsesh_retired_runtime';
      contentUrl.password = 'epic6975-owned-retired-runtime-only';
      for (const [name, content] of Object.entries({
        DATABASE_URL: contentUrl.toString(),
        AUTH_IDENTITY_DATABASE_URL: writerUrl.toString(),
        AUTH_IDENTITY_DATABASE_CONTRACT: contract,
        CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
        CURRENT_STORE_BROWSER_PASSWORD_MODE: 'backend-staging',
        CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'required',
        CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
        CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
        CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
        CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-browser-password-deleted-email-key-distinct',
        NEXTAUTH_SECRET: readerSecret,
        EMAIL_VERIFICATION_ENABLED: 'true',
        AUTH_CUTOFF_ENFORCEMENT: 'enforce',
        DEBUG_SQL: 'false',
      }))
        vi.stubEnv(name, content);
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await closeCredentialDatabase();
      vi.unstubAllEnvs();
    });
    afterAll(async () => {
      await closeCredentialDatabase();
      if (server)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await closeOwner?.();
    });
    it('preserves the existing ordinary password API and exact submitted bytes', async () => {
      const current = await setup('canonical-token', false, 'current-store');
      const authority = { ...qualification(), expectedWriterEpoch: 1, emailVerificationEnabled: true };
      const invoke = (password: string) =>
        authenticateWebPassword(databaseInstance, authority, {
          protocolVersion: 2,
          requestId: randomUUID(),
          issuedAt: Date.now(),
          credentialProofVersion: 1,
          operation: 'password',
          payload: { email: current.email, password },
        });
      const databaseInstance = await database();
      const authenticated = await invoke(plainPassword);
      expect(authenticated.outcome).toBe('authenticated');
      if (authenticated.outcome !== 'authenticated') throw new Error('Owned ordinary password login failed');
      expect(authenticated.user.id).toBe(current.targetId);
      expect((await invoke(plainPassword.trim())).outcome).toBe('invalid_credentials');
    });
    for (const authority of ['current-store', 'better-auth'] as const)
      for (const kind of ['legacy-jwe', 'canonical-token'] as const)
        for (const selected of [false, true])
          it(`${authority}/${kind}/${selected ? 'selected A→B' : 'anonymous'}: exact publication and read-only ACK`, async () => {
            const current = await setup(kind, selected, authority),
              reply = await prepare(current),
              payload = await bound(current, reply);
            expect(reply.preparation.passwordVerifiedAt).not.toBeNull();
            expect(reply.preparation.credentialProof.authenticatedAt).toBe(
              new Date(Math.floor(Date.parse(reply.preparation.passwordVerifiedAt) / 1_000) * 1_000).toISOString(),
            );
            expect(
              Date.parse(reply.preparation.credentialExpiresAt) -
                Date.parse(reply.preparation.credentialProof.authenticatedAt),
            ).toBe(30 * 86_400_000);
            expect(reply.preparation.sourceIntentRevision).toBe(current.before.intentRevision);
            expect(reply.preparation.intentRevision).toBe(current.before.intentRevision + 1);
            expect((await post('finalize', payload)).body.outcome).toBe('completed');
            const after = await snapshot(),
              beforeRequests = finalizeRequests;
            expect((await post('acknowledge', payload)).body.outcome).toBe('completed');
            expect(finalizeRequests).toBe(beforeRequests);
            expect((await post('finalize', payload)).status).toBe(409);
            expect((await post('abort', { ...payload, candidate: undefined })).status).toBe(409);
            expect(await snapshot()).toBe(after);
            const [binding] = await ownerDatabase
              .select()
              .from(authBrowserBindings)
              .where(eq(authBrowserBindings.id, reply.preparation.browserCursor.bindingId));
            expect(binding.userId).toBe(current.targetId);
            expect(binding.version).toBe(current.source.expectedVersion + 1);
            expect(binding.expiresAt).toEqual(current.before.expiresAt);
            expect(
              await executeFirstRow(await database(), sql`SELECT current_user AS role, session_user AS "sessionRole"`),
            ).toEqual({ role: 'boardsesh_identity_writer', sessionRole: 'boardsesh_identity_writer' });
          });
    it.each(['legacy-jwe', 'canonical-token'] as const)(
      '%s: same-account login creates a fresh SID without extending the binding',
      async (kind) => {
        const current = await setup(kind, true, 'current-store', true),
          reply = await prepare(current);
        expect(reply.preparation.credentialProof.authSessionId).not.toBe(current.before.authSessionId);
        expect((await post('finalize', await bound(current, reply))).body.outcome).toBe('completed');
      },
    );
    it('refuses live selected missing-proof preparation without an anonymous fallback', async () => {
      const current = await setup('canonical-token', true, 'current-store');
      const result = await post('prepare', {
        source: { state: 'anonymous', bindingToken: current.source.bindingToken, expectedVersion: 1 },
        email: current.email,
        password: plainPassword,
        credentialKind: current.kind,
        nonceHash: 'e'.repeat(64),
      });
      expect(result.status).toBe(409);
    });
    it('wrong password takes no account lock while that target is held', async () => {
      const current = await setup('canonical-token', false, 'current-store');
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>((resolve) => {
          release = resolve;
        }),
        acquired = new Promise<void>((resolve) => {
          entered = resolve;
        });
      const blocker = ownerDatabase.transaction(async (transaction) => {
        await transaction.select().from(users).where(eq(users.id, current.targetId)).for('update');
        entered();
        await held;
      });
      await acquired;
      try {
        expect(
          (
            await post('prepare', {
              source: current.source,
              email: current.email,
              password: 'wrong',
              credentialKind: current.kind,
              nonceHash: 'e'.repeat(64),
            })
          ).body.outcome,
        ).toBe('invalid_credentials');
      } finally {
        release();
        await blocker;
      }
    });
    it('refuses a reset committed after the actual comparator but before the prepare lock', async () => {
      const current = await setup('canonical-token', false, 'current-store');
      const actual = passwordModule.matchCurrentStorePasswordCandidate;
      vi.spyOn(passwordModule, 'matchCurrentStorePasswordCandidate').mockImplementation(async (...argumentsInput) => {
        const matched = await actual(...argumentsInput);
        await ownerDatabase
          .insert(authSubjectCutoffs)
          .values({
            userId: current.targetId,
            generation: 1,
            revokedThrough: new Date(),
            lastOperationId: randomUUID(),
          })
          .onConflictDoUpdate({ target: authSubjectCutoffs.userId, set: { generation: 1 } });
        return matched;
      });
      expect(
        (
          await post('prepare', {
            source: current.source,
            email: current.email,
            password: plainPassword,
            credentialKind: current.kind,
            nonceHash: 'e'.repeat(64),
          })
        ).body.outcome,
      ).toBe('invalid_credentials');
    });
    it('rolls back candidate, browser CAS and completion after crossing the final DB deadline', async () => {
      const current = await setup('canonical-token', false, 'current-store', false, { bindingMs: 1_000 }),
        reply = await prepare(current),
        payload = await bound(current, reply);
      const before = await snapshot(),
        actual = bindingModule.commitBrowserLoginInTransaction;
      vi.spyOn(bindingModule, 'commitBrowserLoginInTransaction').mockImplementation(async (...argumentsInput) => {
        const committed = await actual(...argumentsInput);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, Date.parse(reply.preparation.expiresAt) - Date.now() + 20)),
        );
        return committed;
      });
      expect((await post('finalize', payload)).status).toBe(409);
      expect(await snapshot()).toBe(before);
    });
    it('ACK alone recovers exact durable completion after the actual selected source expires', async () => {
      const current = await setup('canonical-token', true, 'current-store', false, { sourceSeconds: 2 }),
        reply = await prepare(current),
        payload = await bound(current, reply);
      expect((await post('finalize', payload)).body.outcome).toBe('completed');
      const before = await snapshot();
      if (reply.preparation.source.state !== 'selected') throw new Error('Owned selected source absent');
      const sourceExpiresAt = reply.preparation.source.expiresAt;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(sourceExpiresAt) - Date.now() + 20)));
      expect((await post('acknowledge', payload)).body.outcome).toBe('completed');
      expect((await post('finalize', payload)).status).toBe(409);
      expect(await snapshot()).toBe(before);
    });
    it.each(['current-store', 'better-auth'] as const)(
      '%s refuses an authoritative password change after preparation',
      async (authority) => {
        const current = await setup('canonical-token', false, authority);
        const reply = await prepare(current);
        const payload = await bound(current, reply);
        const replacementHash = await hash('new password', 4);
        await ownerDatabase.transaction(async (transaction) => {
          const receipt = await captureIdentityAuthority(transaction, qualification());
          const identity = bindIdentityAuthority(transaction, receipt);
          const previous = await identity.readPassword(current.targetId, 'update');
          if (!previous) throw new Error('Owned existing credential missing');
          expect(await identity.replacePassword(previous, replacementHash)).toBe(true);
        });
        const before = await snapshot();
        expect((await post('finalize', payload)).status).toBe(409);
        expect(await snapshot()).toBe(before);
      },
    );
    it('does not ACK different candidate bytes or a revoked target', async () => {
      const current = await setup('canonical-token', false, 'current-store'),
        reply = await prepare(current),
        payload = await bound(current, reply);
      expect((await post('finalize', payload)).body.outcome).toBe('completed');
      const before = await snapshot();
      expect(
        (await post('acknowledge', { ...payload, candidate: { kind: 'canonical-token', token: opaque() } })).status,
      ).toBe(409);
      expect(await snapshot()).toBe(before);
      await ownerDatabase
        .insert(authSubjectCutoffs)
        .values({ userId: current.targetId, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() })
        .onConflictDoUpdate({ target: authSubjectCutoffs.userId, set: { generation: 1 } });
      expect((await post('acknowledge', payload)).status).toBe(401);
    });
    it('preserves newer intent state when an old pending abort arrives', async () => {
      const current = await setup('canonical-token', false, 'current-store'),
        reply = await prepare(current),
        payload = await bound(current, reply);
      expect(
        (
          await beginBrowserIntent(await database(), qualification(), current.source.bindingToken, {
            operation: 'login',
            expectedVersion: 0,
          })
        ).status,
      ).toBe('prepared');
      const before = await snapshot();
      expect((await post('abort', { ...payload, candidate: undefined })).status).toBe(409);
      expect(await snapshot()).toBe(before);
    });
    it('aborts its own pending operation without publishing a candidate or changing the selection', async () => {
      const current = await setup('canonical-token', false, 'current-store');
      const reply = await prepare(current);
      const payload = await bound(current, reply);
      expect((await post('abort', { ...payload, candidate: undefined })).body.outcome).toBe('aborted');
      const afterAbort = await snapshot();
      expect((await post('finalize', payload)).status).toBe(409);
      expect(await snapshot()).toBe(afterAbort);
      const [binding] = await ownerDatabase
        .select()
        .from(authBrowserBindings)
        .where(eq(authBrowserBindings.id, reply.preparation.browserCursor.bindingId));
      expect(binding.userId).toBeNull();
      expect(binding.version).toBe(current.before.version);
      expect(
        await ownerDatabase
          .select()
          .from(authSession)
          .where(eq(authSession.id, reply.preparation.credentialProof.authSessionId)),
      ).toEqual([]);
    });
    it('retains pending/completed recovery receipts until ACK expiry and bounds exact-purpose cleanup', async () => {
      // Qualify before fixture insertion, so an unavailable profile leaves no new backlog.
      const writer = await database();
      const [backlog] = await writer
        .select({ count: sql<number>`count(*)::int` })
        .from(verificationTokens)
        .where(
          and(
            like(verificationTokens.identifier, `${BROWSER_PASSWORD_RECEIPT_PREFIX}%`),
            lte(verificationTokens.expires, sql`clock_timestamp() AT TIME ZONE 'UTC'`),
          ),
        );
      if (!backlog) throw new Error('Owned maintenance backlog count unavailable');
      const marker = randomUUID(),
        prefix = BROWSER_PASSWORD_RECEIPT_PREFIX + marker + ':',
        future = new Date(Date.now() + 60_000);
      const preserved = [
        { identifier: prefix + 'pending-live', token: digest('pending'), expires: future },
        { identifier: prefix + 'completed-live', token: digest('completed'), expires: future },
        { identifier: 'password-reset:owned-' + marker, token: digest('other-purpose'), expires: new Date(0) },
      ];
      await ownerDatabase.insert(verificationTokens).values([
        ...preserved,
        {
          identifier: prefix + 'expired-at-deadline',
          token: digest('at-deadline'),
          expires: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
        },
        ...Array.from({ length: 1_001 }, (_, index) => ({
          identifier: prefix + 'expired-' + index,
          token: digest(String(index)),
          expires: new Date(0),
        })),
      ]);
      // A finite bound includes measured retained backlog and one clock-boundary allowance.
      const maximumCalls = Math.ceil((backlog.count + 1_002) / 1_000) + 1;
      for (let invocation = 0; invocation < maximumCalls; invocation++) {
        const removed = await deleteExpiredBrowserPasswordReceipts(writer);
        expect(removed).toBeGreaterThanOrEqual(0);
        expect(removed).toBeLessThanOrEqual(1_000);
        if (invocation === 0) expect(removed).toBe(1_000);
        const current = await ownerDatabase
          .select()
          .from(verificationTokens)
          .where(like(verificationTokens.identifier, prefix + '%'));
        for (const receipt of preserved) {
          const [retained] = await ownerDatabase
            .select()
            .from(verificationTokens)
            .where(eq(verificationTokens.identifier, receipt.identifier));
          expect(retained).toEqual(receipt);
        }
        const expired = current.filter((receipt) => receipt.identifier.includes('expired-'));
        if (invocation === 0) expect(expired.length).toBeGreaterThanOrEqual(1);
        if (expired.length === 0) break;
      }
      expect(
        (
          await ownerDatabase
            .select()
            .from(verificationTokens)
            .where(like(verificationTokens.identifier, prefix + '%'))
        )
          .map((receipt) => receipt.identifier)
          .sort(),
      ).toEqual([prefix + 'completed-live', prefix + 'pending-live']);
    });
  });
