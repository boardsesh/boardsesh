import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authAccount,
  authCredentialLineage,
  authProviderReauthenticationReceipts,
  authProviderSecurityIntents,
  authSession,
  authSubjectCutoffs,
} from '@boardsesh/db/schema/auth';
import { createProviderSecurityEnvironment } from './provider-security-fixture';
import { finalizeProviderSecurityMutation, prepareProviderSecurityMutation } from '../provider-security-finalizer';
import { bindProviderSecurityFlow, createProviderSecurityIntent } from '../provider-security-intents';
import { reauthenticateProviderWithPassword } from '../provider-security-reauthentication';
import { acknowledgeProviderSecurityResult } from '../provider-security-terminal';
import { providerTokenHash, providerWebSessionHash } from '../provider-security-context';
import {
  readFirstPartySession,
  requireFreshAuthentication,
  webSignInProof,
  type FirstPartyCredential,
} from '../session-reader';
import { readLockedWebSubjectState } from '../../current-store/web-credential-state';
import { rollWebSession, signOutWebSession } from '../web-session';
import { captureIdentityAuthority } from '../router';
import { recordFunctionLevelIdentityMirrorForTests } from '../mirror-activation';

// These writers run with the mirror on and no backend boot (function-level mirror).
recordFunctionLevelIdentityMirrorForTests();

let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
// The real sign-out reads the account through the admission pool; point it at this suite's database.
vi.mock('../../admission-pool', () => ({
  readOnAdmissionConnection: async (
    mark: () => void,
    read: (database: typeof environment.database) => PromiseLike<unknown>,
  ) => {
    mark();
    return read(environment.database);
  },
}));
type Owner = Awaited<ReturnType<typeof environment.actor>>;

async function admit(credential: FirstPartyCredential) {
  const outcome = await environment.database.transaction((transaction) =>
    readFirstPartySession(transaction, credential, new Date(), (userId) =>
      readLockedWebSubjectState(transaction, userId),
    ),
  );
  if (outcome.status !== 'admitted') throw new Error(`Session not admitted: ${outcome.status}`);
  return outcome.session;
}
async function sessionRow(sessionId: string) {
  const [row] = await environment.database.select().from(authSession).where(eq(authSession.id, sessionId));
  return row;
}
async function intentRow(intentToken: string) {
  const [row] = await environment.database
    .select()
    .from(authProviderSecurityIntents)
    .where(eq(authProviderSecurityIntents.intentHash, providerTokenHash(intentToken)));
  return row;
}
async function linkedApple(owner: Owner, subject: string) {
  const rows = await Promise.all([
    environment.database
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, owner.userId), eq(accounts.providerAccountId, subject))),
    environment.database
      .select()
      .from(authAccount)
      .where(and(eq(authAccount.userId, owner.userId), eq(authAccount.accountId, subject))),
  ]);
  return rows.flat().length > 0;
}
/** A link up to its reauthentication, without proving it. */
async function startLink(owner: Owner) {
  const intent = await createProviderSecurityIntent(environment.database, environment.runtime, {
    actor: owner.webActor,
    action: 'link',
    provider: 'apple',
    methodId: null,
  });
  const bound = { actor: owner.webActor, intentToken: intent.intentToken };
  const flowHash = randomBytes(32).toString('hex');
  await bindProviderSecurityFlow(environment.database, environment.runtime, { ...bound, flowHash });
  const subject = randomBytes(16).toString('hex');
  const providerProof = { provider: 'apple' as const, subject, email: 'verified@example.test', emailVerified: true };
  return { intent, bound, flowHash, subject, providerProof };
}

describe('provider security keyed by the first-party web session (#7596 B5c1)', () => {
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
  });
  afterAll(async () => environment?.close());

  it('stores a prefixed SHA-256 of the session id in the NOT NULL binding columns, never a binding token', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const { intent } = await startLink(owner);
    const row = await intentRow(intent.intentToken);
    expect(row.browserBindingHash).toBe(providerWebSessionHash(owner.sid));
    expect(row.browserBindingHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.browserBindingHash).not.toBe(createHash('sha256').update(owner.sid).digest('hex'));
    // Never the hash of the session token itself either.
    expect(row.browserBindingHash).not.toBe(providerTokenHash(owner.actor.credential));
    expect(row.browserVersion).toBe(0);
    expect(row.browserBindingExpiresAt).toEqual(owner.sourceExpiresAt);
    expect(row).toMatchObject({
      actorSessionId: owner.sid,
      actorGeneration: 0,
      actorCredentialKind: 'canonical-token',
    });
  });

  it('a roll between prepare and finalize does not break the flow, and finalize keeps the rolled expiry', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const prepared = await environment.prepareLink(owner);
    const roll = await rollWebSession(environment.database, owner.sid, new Date());
    if (!roll.rolled) throw new Error('The session did not roll');
    expect(roll.expiresAt.getTime()).toBeGreaterThan(owner.sourceExpiresAt.getTime());
    expect(await finalizeProviderSecurityMutation(environment.database, environment.runtime, prepared)).toEqual({
      outcome: 'committed',
      generation: 1,
    });
    expect((await sessionRow(owner.sid)).expiresAt).toEqual(roll.expiresAt);
    expect(await admit(owner.credential)).toMatchObject({ generation: 1, expiresAt: roll.expiresAt });
    expect(await acknowledgeProviderSecurityResult(environment.database, environment.runtime, prepared)).toEqual({
      outcome: 'recovered',
      generation: 1,
    });
  });

  it('a session signed out between prepare and finalize fails closed and writes nothing', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const prepared = await environment.prepareLink(owner);
    const authority = await environment.database.transaction((transaction) =>
      captureIdentityAuthority(transaction, environment.qualification),
    );
    expect(
      await signOutWebSession(
        environment.database,
        { credential: owner.credential, expectedUserId: owner.userId, expectedAuthSessionId: owner.sid },
        { ...environment.qualification, expectedWriterEpoch: authority.epoch },
      ),
    ).toBe('signed-out');
    await expect(
      finalizeProviderSecurityMutation(environment.database, environment.runtime, prepared),
    ).rejects.toMatchObject({ outcome: 'unauthenticated', code: 'invalid_proof' });
    expect(await linkedApple(owner, prepared.subject)).toBe(false);
    expect(
      await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, owner.userId)),
    ).toHaveLength(0);
    expect((await intentRow(prepared.intentToken)).phase).toBe('prepared');
    const [receipt] = await environment.database
      .select()
      .from(authProviderReauthenticationReceipts)
      .where(eq(authProviderReauthenticationReceipts.receiptHash, providerTokenHash(prepared.reauthenticationToken)));
    expect(receipt.consumedAt).toBeNull();
    // Sign-out ended the row; nothing moved it to a new generation.
    expect((await sessionRow(owner.sid))?.revocationGeneration ?? 0).toBe(0);
    await expect(admit(owner.credential)).rejects.toThrow('Session not admitted: denied');
  });

  for (const source of ['login', 'bridge', 'carried'] as const)
    it(`a ${source} session signed in seconds ago still needs a real reauthentication, then links`, async () => {
      const owner = await environment.actor('better-auth', 'canonical-token', { source, signedInSecondsAgo: 5 });
      const session = await admit(owner.credential);
      expect(session.source).toBe(source === 'login' ? 'login' : 'bridge');
      // Only a login counts as a fresh sign-in; bridged and carried never do.
      expect(requireFreshAuthentication(session)).toBe(source === 'login');
      const { bound, flowHash, providerProof, intent } = await startLink(owner);
      // No session age, however fresh, stands in for the reauthentication receipt.
      await expect(
        prepareProviderSecurityMutation(environment.database, environment.runtime, {
          ...bound,
          reauthenticationToken: randomBytes(32).toString('base64url'),
          flowHash,
          providerProof,
        }),
      ).rejects.toMatchObject({ outcome: 'reauthentication_required' });
      expect((await intentRow(intent.intentToken)).phase).toBe('pending');
      const proof = await reauthenticateProviderWithPassword(environment.database, environment.runtime, {
        ...bound,
        password: ' exact password ',
      });
      const prepared = await prepareProviderSecurityMutation(environment.database, environment.runtime, {
        ...bound,
        reauthenticationToken: proof.reauthenticationToken,
        flowHash,
        providerProof,
      });
      if (prepared.outcome !== 'prepared') throw new Error('Preparation refused');
      expect(
        await finalizeProviderSecurityMutation(environment.database, environment.runtime, {
          ...bound,
          reauthenticationToken: proof.reauthenticationToken,
          preparationToken: prepared.preparationToken,
        }),
      ).toEqual({ outcome: 'committed', generation: 1 });
      expect(await linkedApple(owner, providerProof.subject)).toBe(true);
      // The requesting session keeps its source and its lineage.
      expect(await admit(owner.credential)).toMatchObject({ generation: 1, source: session.source });
      if (source === 'bridge') {
        const [lineage] = await environment.database
          .select()
          .from(authCredentialLineage)
          .where(eq(authCredentialLineage.sessionId, owner.sid));
        expect(lineage.revokedAt).toBeNull();
      }
    });

  it('a link never moves the sign-in time: an old sign-in stays old, so it is still not fresh', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const before = await admit(owner.credential);
    const beforeRow = await sessionRow(owner.sid);
    expect(requireFreshAuthentication(before)).toBe(false);
    const prepared = await environment.prepareLink(owner);
    expect((await finalizeProviderSecurityMutation(environment.database, environment.runtime, prepared)).outcome).toBe(
      'committed',
    );
    const after = await admit(owner.credential);
    const afterRow = await sessionRow(owner.sid);
    expect(after.authenticatedAt).toEqual(owner.authenticatedAt);
    expect(after.source).toBe('login');
    expect(requireFreshAuthentication(after)).toBe(false);
    expect(webSignInProof(after)).toEqual(webSignInProof(before));
    expect(afterRow.originalAuthenticatedAt).toEqual(beforeRow.originalAuthenticatedAt);
    expect(afterRow.createdAt).toEqual(beforeRow.createdAt);
    expect(afterRow.expiresAt).toEqual(beforeRow.expiresAt);
    expect(afterRow.token).toBe(beforeRow.token);
  });
});
