import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { authSession, authSecurityMutationEvents, authSubjectCutoffs, users } from '@boardsesh/db/schema/auth';
import { createProviderSecurityEnvironment } from './provider-security-fixture';
import { continueProviderSessionInPlace } from '../provider-security-continuation';
import { recordIdentitySecurityMutation } from '../security-mutation';
import { recordIdentityPasswordMutation } from '../password-mutation';
import { captureIdentityAuthority } from '../router';
import { readFirstPartySession, type FirstPartySession } from '../session-reader';
import { readLockedWebSubjectState } from '../../current-store/web-credential-state';
import { transactionSettings } from '../../current-store/command-context';
import { recordFunctionLevelIdentityMirrorForTests } from '../mirror-activation';
import type { AuthorityTransaction } from '../adapter';

// #7596 B5c2 review S2-1: the in-place continuation accepts link, unlink and
// password-set receipts. Only the receipt of THIS operation, of the stated
// kind, minted in THIS transaction, lets a session survive its generation move.
recordFunctionLevelIdentityMirrorForTests();

let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
type Owner = Awaited<ReturnType<typeof environment.actor>>;
type Minted = Awaited<ReturnType<typeof recordIdentitySecurityMutation>>;

async function session(owner: Owner): Promise<FirstPartySession> {
  const read = await environment.database.transaction((transaction) =>
    readFirstPartySession(transaction, owner.credential, new Date(), (userId) =>
      readLockedWebSubjectState(transaction, userId),
    ),
  );
  if (read.status !== 'admitted') throw new Error('Owned session did not admit');
  return read.session;
}
async function state(owner: Owner) {
  return {
    session: await environment.database.select().from(authSession).where(eq(authSession.id, owner.sid)),
    cutoffs: await environment.database
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, owner.userId)),
    events: await environment.database
      .select()
      .from(authSecurityMutationEvents)
      .where(eq(authSecurityMutationEvents.userId, owner.userId)),
  };
}
/** Mint a real receipt in a transaction, run `use` with it, and always roll back. */
async function withReceipt(
  owner: Owner,
  kind: 'provider-link' | 'password-set',
  operationId: string,
  use: (transaction: AuthorityTransaction, minted: Minted) => Promise<unknown>,
) {
  const rollback = new Error('ROLLBACK_AFTER_PROBE');
  try {
    await environment.database.transaction(async (transaction) => {
      await transactionSettings(transaction);
      const authority = await captureIdentityAuthority(transaction, environment.qualification);
      await transaction.select({ id: users.id }).from(users).where(eq(users.id, owner.userId)).for('update');
      const options = {
        expectedProjectionId: authority.projectionId,
        expectedNormalizerVersion: authority.normalizerVersion,
        expectedWriterEpoch: authority.epoch,
        operationId,
        userId: owner.userId,
        expectedGeneration: 0,
        domains: ['first-party', 'partner'] as ['first-party', 'partner'],
      };
      const minted =
        kind === 'password-set'
          ? await recordIdentityPasswordMutation(transaction, { ...options, kind }, authority)
          : await recordIdentitySecurityMutation(transaction, { ...options, kind }, authority);
      await use(transaction, minted);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describe('the in-place continuation takes only the right receipt', () => {
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
  });
  afterAll(async () => environment?.close());

  it.each([
    ['provider-link', 'password-set'],
    ['password-set', 'provider-link'],
    ['password-set', 'provider-unlink'],
  ] as const)('a %s receipt cannot continue a %s', async (minted, expected) => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const actor = await session(owner);
    const before = await state(owner);
    const operationId = randomUUID();
    let refusal: unknown;
    await withReceipt(owner, minted, operationId, async (transaction, result) => {
      refusal = await continueProviderSessionInPlace(
        transaction,
        actor,
        owner.actor.credential,
        result.identityGenerationReceipt,
        { operationId, kind: expected },
        new Date(),
      ).catch((error: unknown) => error);
    });
    expect(refusal).toMatchObject({ message: 'AUTH_IDENTITY_CONTINUATION_RECEIPT_INVALID' });
    expect(await state(owner)).toEqual(before);
  });

  it('a receipt for another operation id is refused', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const actor = await session(owner);
    const before = await state(owner);
    let refusal: unknown;
    await withReceipt(owner, 'password-set', randomUUID(), async (transaction, result) => {
      refusal = await continueProviderSessionInPlace(
        transaction,
        actor,
        owner.actor.credential,
        result.identityGenerationReceipt,
        { operationId: randomUUID(), kind: 'password-set' },
        new Date(),
      ).catch((error: unknown) => error);
    });
    expect(refusal).toMatchObject({ message: 'AUTH_IDENTITY_CONTINUATION_RECEIPT_INVALID' });
    expect(await state(owner)).toEqual(before);
  });

  it('a receipt minted in another transaction is refused', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const actor = await session(owner);
    const before = await state(owner);
    const operationId = randomUUID();
    let refusal: unknown;
    await withReceipt(owner, 'provider-link', operationId, async (transaction, result) => {
      // A savepoint is a different transaction object: the receipt is bound to the outer one.
      refusal = await transaction
        .transaction((savepoint) =>
          continueProviderSessionInPlace(
            savepoint,
            actor,
            owner.actor.credential,
            result.identityGenerationReceipt,
            { operationId, kind: 'provider-link' },
            new Date(),
          ),
        )
        .catch((error: unknown) => error);
    });
    expect(refusal).toMatchObject({ message: 'AUTH_IDENTITY_MUTATION_RECEIPT_INVALID' });
    expect(await state(owner)).toEqual(before);
  });

  it('the matching receipt continues the session in place, as the control', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const actor = await session(owner);
    const operationId = randomUUID();
    let continued: unknown;
    await withReceipt(owner, 'password-set', operationId, async (transaction, result) => {
      continued = await continueProviderSessionInPlace(
        transaction,
        actor,
        owner.actor.credential,
        result.identityGenerationReceipt,
        { operationId, kind: 'password-set' },
        new Date(),
      );
    });
    expect(continued).toEqual({ generation: 1 });
  });
});
