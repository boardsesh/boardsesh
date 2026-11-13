import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  authBrowserBindings,
  authCredentialLineage,
  authEmailProjection,
  authSession,
  authSessionDenials,
  authSubjectCutoffs,
  users,
} from '@boardsesh/db/schema/auth';
import { createEnvironment } from './environment';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import {
  beginBrowserIntent,
  commitBrowserLogin,
  createUnpublishedBrowserBinding,
  type BrowserSelectionCredential,
} from '../browser-binding';
import { switchIdentityAuthority } from '../router';
import {
  admitBrowserDelegation,
  issueBrowserDelegation,
  BROWSER_DELEGATION_LIFETIME_MS,
  BROWSER_DELEGATION_PREFIX,
} from '../browser-delegation';
import type { FirstPartyCredential } from '../session-reader';

const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = requireWeb('next-auth/jwt') as {
  encode(input: { secret: string; token: Record<string, unknown>; maxAge: number }): Promise<string>;
};
const webSecret = 'owned-browser-delegation-legacy-secret-6975';
const secrets = {
  NEXTAUTH_SECRET: webSecret,
  BROWSER_DELEGATION_SECRET: 'owned-backend-only-delegation-secret-6975',
  CURRENT_STORE_AUTH_RPC_SECRET: 'owned-delegation-rpc-secret-distinct-6975',
};
const qualification = {
  expectedProjectionId: randomUUID(),
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
};
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let userId: string;
let otherUserId: string;

async function source(
  kind: 'legacy-jwe' | 'canonical-token',
  options: { user?: string; knownAge?: boolean; padding?: string; expiry?: Date } = {},
): Promise<FirstPartyCredential> {
  const owner = options.user ?? userId;
  const authenticatedAt = options.knownAge ? new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000) : null;
  const authSessionId = randomUUID();
  if (kind === 'legacy-jwe')
    return {
      kind,
      secret: webSecret,
      credential: await jwt.encode({
        secret: webSecret,
        maxAge: 3600,
        token: {
          sub: owner,
          authSessionId,
          gen: 0,
          ...(authenticatedAt ? { auth_time: authenticatedAt.getTime() / 1000, link_guarded: true } : {}),
          ...(options.padding ? { padding: options.padding } : {}),
        },
      }),
    };
  const token = `owned-opaque-${randomUUID()}-é`;
  await environment.database.insert(authSession).values({
    id: authSessionId,
    token,
    userId: owner,
    expiresAt: options.expiry ?? new Date(Date.now() + 3_600_000),
    updatedAt: new Date(),
    revocationGeneration: 0,
    originalAuthenticatedAt: authenticatedAt,
    legacyLineageId: `credential:${authSessionId}`,
  });
  return { kind, token };
}
async function selected(credential: FirstPartyCredential) {
  const binding = await createUnpublishedBrowserBinding(environment.database, qualification);
  if (binding.status !== 'created') throw new Error('Owned binding unavailable');
  const intent = await beginBrowserIntent(environment.database, qualification, binding.token, {
    operation: 'login',
    expectedVersion: 0,
  });
  if (intent.status !== 'prepared') throw new Error('Owned intent unavailable');
  const committed = await commitBrowserLogin(
    environment.database,
    qualification,
    binding.token,
    intent.intentToken,
    credential,
  );
  if (committed.status !== 'committed' || !committed.session) throw new Error('Owned selection unavailable');
  const actor: BrowserSelectionCredential = { version: committed.cursor.version, credential };
  return { bindingToken: binding.token, actor, session: committed.session, cursor: committed.cursor };
}
async function issued(credential: FirstPartyCredential) {
  const selection = await selected(credential);
  const result = await issueBrowserDelegation(environment.database, qualification, selection, secrets);
  expect(result.status).toBe('admitted');
  if (result.status !== 'admitted') throw new Error('Owned delegation unavailable');
  return { ...selection, ...result };
}
const admit = (token: string) => admitBrowserDelegation(environment.database, qualification, token, secrets);

describe('backend-only selected browser delegation on actual PostgreSQL', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    for (const tag of ['0311_browser_binding_selection', '0312_browser_selection_possession'])
      await environment.client.unsafe(
        readFileSync(new URL(`../../../../../db/drizzle/${tag}.sql`, import.meta.url), 'utf8'),
      );
  });
  beforeEach(async () => {
    await environment.client.unsafe(
      'TRUNCATE auth_browser_bindings, auth_email_projection, auth_migration_epochs, auth_subject_cutoffs, auth_session_denials, auth_security_mutation_events, auth_credential_lineage, users CASCADE',
    );
    userId = randomUUID();
    otherUserId = randomUUID();
    await environment.database.insert(users).values([
      { id: userId, email: `${userId}@example.test` },
      { id: otherUserId, email: `${otherUserId}@example.test` },
    ]);
    await environment.database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId: qualification.expectedProjectionId });
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    });
  });
  afterAll(async () => environment?.close());

  for (const authority of ['current-store', 'better-auth'] as const)
    describe(authority, () => {
      beforeEach(async () => {
        if (authority === 'better-auth')
          await environment.database.transaction((transaction) =>
            switchIdentityAuthority(transaction, {
              projectionId: qualification.expectedProjectionId,
              from: 'current-store',
              to: 'better-auth',
              epoch: 1,
            }),
          );
      });
      for (const kind of ['legacy-jwe', 'canonical-token'] as const)
        describe(kind, () => {
          it.each([false, true])(
            'retains exact source age, SID, ancestry and expiry, known age=%s',
            async (knownAge) => {
              const proof = await source(kind, { knownAge });
              const lease = await issued(proof);
              expect(lease.token.startsWith(BROWSER_DELEGATION_PREFIX)).toBe(true);
              expect(Buffer.byteLength(lease.token)).toBeLessThanOrEqual(4096);
              expect(lease.token).not.toContain(
                kind === 'canonical-token'
                  ? (proof as Extract<FirstPartyCredential, { kind: 'canonical-token' }>).token
                  : userId,
              );
              expect(lease.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + BROWSER_DELEGATION_LIFETIME_MS);
              expect(await admit(lease.token)).toEqual({
                status: 'admitted',
                session: lease.session,
                expiresAt: lease.expiresAt,
              });
              expect(lease.session.authenticatedAt === null).toBe(!knownAge);
            },
          );
          it('cannot mint with a known binding and another actual source', async () => {
            const selection = await selected(await source(kind));
            const candidate = await source(kind, { user: otherUserId });
            expect(
              await issueBrowserDelegation(
                environment.database,
                qualification,
                {
                  bindingToken: selection.bindingToken,
                  actor: { version: selection.actor.version, credential: candidate },
                },
                secrets,
              ),
            ).toEqual({ status: 'denied' });
          });
          it('refuses a previously admitted lease immediately after an A to B selection', async () => {
            const lease = await issued(await source(kind));
            const intent = await beginBrowserIntent(environment.database, qualification, lease.bindingToken, {
              operation: 'login',
              expectedVersion: lease.actor.version,
              presented: lease.actor,
            });
            if (intent.status !== 'prepared') throw new Error('Owned switch unavailable');
            expect(
              (
                await commitBrowserLogin(
                  environment.database,
                  qualification,
                  lease.bindingToken,
                  intent.intentToken,
                  await source(kind, { user: otherUserId }),
                  lease.actor,
                )
              ).status,
            ).toBe('committed');
            expect(await admit(lease.token)).toEqual({ status: 'denied' });
          });
          it('rechecks generation and SID denial on every use', async () => {
            const lease = await issued(await source(kind));
            expect((await admit(lease.token)).status).toBe('admitted');
            await environment.database
              .insert(authSessionDenials)
              .values({ sessionId: lease.session.authSessionId, userId, expiresAt: lease.session.expiresAt });
            expect(await admit(lease.token)).toEqual({ status: 'denied' });
            await environment.database.delete(authSessionDenials).where(eq(authSessionDenials.userId, userId));
            const changed = await environment.database
              .insert(authSubjectCutoffs)
              .values({ userId, generation: 1, revokedThrough: new Date(0), lastOperationId: randomUUID() })
              .returning({ generation: authSubjectCutoffs.generation });
            expect(changed).toEqual([{ generation: 1 }]);
            expect(await admit(lease.token)).toEqual({ status: 'denied' });
          });
          it('refuses when primary authority changes after issuance', async () => {
            const lease = await issued(await source(kind));
            await environment.database.transaction((transaction) =>
              switchIdentityAuthority(transaction, {
                projectionId: qualification.expectedProjectionId,
                from: authority,
                to: authority === 'current-store' ? 'better-auth' : 'current-store',
                epoch: authority === 'current-store' ? 1 : 2,
              }),
            );
            expect(await admit(lease.token)).toEqual({ status: 'denied' });
          });
        });
    });
  it('does not wrap large legacy source bytes in backend headers', async () => {
    const proof = await source('legacy-jwe', { padding: 'x'.repeat(8000) });
    if (proof.kind !== 'legacy-jwe') throw new Error('Owned source invalid');
    expect(Buffer.byteLength(proof.credential)).toBeGreaterThan(10_000);
    expect(Buffer.byteLength((await issued(proof)).token)).toBeLessThan(2000);
  });
  it('refuses canonical token replacement despite unchanged SID and generation', async () => {
    const lease = await issued(await source('canonical-token'));
    await environment.database
      .update(authSession)
      .set({ token: randomUUID() })
      .where(eq(authSession.id, lease.session.authSessionId));
    expect(await admit(lease.token)).toEqual({ status: 'denied' });
  });
  it('refuses canonical lineage revocation, retaining missing optional lineage compatibility', async () => {
    const lease = await issued(await source('canonical-token'));
    expect((await admit(lease.token)).status).toBe('admitted');
    await environment.database.insert(authCredentialLineage).values({
      id: `credential:${lease.session.authSessionId}`,
      userId,
      sessionId: lease.session.authSessionId,
      originalExpiresAt: lease.session.expiresAt,
      revokedAt: new Date(),
    });
    expect(await admit(lease.token)).toEqual({ status: 'denied' });
  });
  it('honors legacy signing-key retirement and missing-key uncertainty', async () => {
    const lease = await issued(await source('legacy-jwe'));
    expect(
      await admitBrowserDelegation(environment.database, qualification, lease.token, {
        ...secrets,
        NEXTAUTH_SECRET: 'another-owned-signing-key',
      }),
    ).toEqual({ status: 'denied' });
    expect(
      await admitBrowserDelegation(environment.database, qualification, lease.token, {
        ...secrets,
        NEXTAUTH_SECRET: undefined,
      }),
    ).toEqual({ status: 'unavailable' });
    const canonical = await issued(await source('canonical-token'));
    expect(
      (
        await admitBrowserDelegation(environment.database, qualification, canonical.token, {
          ...secrets,
          NEXTAUTH_SECRET: undefined,
        })
      ).status,
    ).toBe('admitted');
  });
  it('ends at the exact source deadline using the real PostgreSQL clock', async () => {
    const lease = await issued(await source('canonical-token', { expiry: new Date(Date.now() + 5000) }));
    expect(lease.expiresAt).toEqual(lease.session.expiresAt);
    expect((await admit(lease.token)).status).toBe('admitted');
    await environment.database.execute(sql`SELECT pg_sleep(GREATEST(0,
      EXTRACT(EPOCH FROM (${lease.expiresAt.toISOString()}::timestamptz - clock_timestamp()))) + 0.01)`);
    expect(await admit(lease.token)).toEqual({ status: 'denied' });
  });
  it.each(['NEXTAUTH_SECRET', 'CURRENT_STORE_AUTH_RPC_SECRET'])(
    'refuses a reused %s issuer key before database access',
    async (name) => {
      const transaction = vi.spyOn(environment.database, 'transaction');
      const result = await admitBrowserDelegation(environment.database, qualification, 'bsbd1_foreign', {
        ...secrets,
        BROWSER_DELEGATION_SECRET: secrets[name as keyof typeof secrets],
      });
      expect(result).toEqual({ status: 'unavailable' });
      expect(transaction).not.toHaveBeenCalled();
      transaction.mockRestore();
    },
  );
  it.each(['bsbd1_', 'bsbd1_invalid=', 'bsbd1_aaaa', 'bsbd1_' + 'x'.repeat(4096)])(
    'refuses malformed delegation without database access',
    async (token) => {
      const transaction = vi.spyOn(environment.database, 'transaction');
      expect(await admit(token)).toEqual({ status: 'denied' });
      expect(transaction).not.toHaveBeenCalled();
      transaction.mockRestore();
    },
  );
  it('distinguishes primary uncertainty from confirmed denial', async () => {
    const lease = await issued(await source('canonical-token'));
    const transaction = vi
      .spyOn(environment.database, 'transaction')
      .mockRejectedValueOnce(new Error('owned-primary-unavailable'));
    expect(await admit(lease.token)).toEqual({ status: 'unavailable' });
    transaction.mockRestore();
    await environment.database
      .update(authBrowserBindings)
      .set({ version: lease.cursor.version + 1 })
      .where(eq(authBrowserBindings.id, lease.cursor.bindingId));
    expect(await admit(lease.token)).toEqual({ status: 'denied' });
  });
});
