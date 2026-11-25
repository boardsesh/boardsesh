import type { DbInstance } from '@boardsesh/db/client';
import { executeFirstRow } from '@boardsesh/db/client';
import {
  AUTH_PROTOCOL_VERSION,
  AUTH_COMMAND_FUTURE_SKEW_MS,
  AUTH_COMMAND_MAX_AGE_MS,
  type SetPasswordCompatibilityCommand,
  type SetPasswordCompatibilityReply,
} from '@boardsesh/auth-protocol';
import { PASSWORD_HASH_COST } from '@boardsesh/auth-protocol/password-hash';
import { authSubjectCutoffs, userCredentials, users } from '@boardsesh/db/schema/auth';
import { hash } from 'bcryptjs';
import { getPostgresErrorCode } from '../../utils/postgres-errors';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { decideCredential, isCredentialAdmitted } from '../credential-cutoffs';
import { decryptLegacyWebJwe } from '../legacy-web-jwe';
import { recordPasswordChangeEvidence } from '../password-change-evidence';
import { claimCommand } from './command-context';
import { lockSubjectRow, type CurrentStoreTransaction } from './foundation-context';
import { capturePreEnforcementContext, revalidatePreEnforcementContext } from './pre-enforcement-context';
import {
  PRIVATE_AUTH_COMMAND_MS,
  privateCommandTransactionSettings,
  requirePrivateCommandBudget,
} from './private-command-budget';
import { readLockedWebSubjectState } from './web-credential-state';
import {
  revalidateSetPasswordCompatibilityScope,
  SetPasswordCompatibilityUnavailable,
  type SetPasswordCompatibilityScope,
} from './set-password-compatibility-scope';

/** Deliberate callback result: the driver must acknowledge OUTER ROLLBACK first. */
class SetPasswordRollbackReply extends Error {
  constructor(readonly reply: SetPasswordCompatibilityReply) {
    super('Set-password rolled back');
  }
}
class MutationRollback extends Error {
  constructor(readonly code: 'rolled_back' | 'unavailable') {
    super('Set-password mutation failed');
  }
}

async function databaseTime(transaction: CurrentStoreTransaction): Promise<Date> {
  const row = await executeFirstRow<{ milliseconds: string | number }>(
    transaction,
    sql`SELECT floor(extract(epoch from clock_timestamp()) * 1000) AS milliseconds`,
  );
  const milliseconds = Number(row?.milliseconds);
  if (!Number.isSafeInteger(milliseconds)) throw new SetPasswordCompatibilityUnavailable();
  return new Date(milliseconds);
}
function requireFreshCommand(issuedAt: number, now: Date) {
  const current = now.getTime();
  if (issuedAt > current + AUTH_COMMAND_FUTURE_SKEW_MS || current - issuedAt > AUTH_COMMAND_MAX_AGE_MS)
    throw new SetPasswordCompatibilityUnavailable();
}

/** The exact driver's original fields, not any unrelated trigger/evidence23505. */
function credentialInsertConflict(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 5 && typeof candidate === 'object' && candidate !== null; depth += 1) {
    if (
      'code' in candidate &&
      candidate.code === '23505' &&
      'schema_name' in candidate &&
      candidate.schema_name === 'public' &&
      'table_name' in candidate &&
      candidate.table_name === 'user_credentials' &&
      'constraint_name' in candidate &&
      candidate.constraint_name === 'user_credentials_pkey'
    )
      return true;
    candidate = 'cause' in candidate ? candidate.cause : undefined;
  }
  return false;
}

type SourceResult = {
  readonly outcome: 'admitted' | 'unauthenticated' | 'identity_changed';
  readonly userId?: string;
  readonly now: Date;
};
async function sourceInTransaction(
  transaction: CurrentStoreTransaction,
  command: SetPasswordCompatibilityCommand,
  scope: SetPasswordCompatibilityScope,
): Promise<SourceResult> {
  const now = await databaseTime(transaction);
  requireFreshCommand(command.issuedAt, now);
  let decrypted: Awaited<ReturnType<typeof decryptLegacyWebJwe>>;
  try {
    decrypted = await decryptLegacyWebJwe(command.payload.credential, scope.secret, 15, now);
  } catch {
    return { outcome: 'unauthenticated', now };
  }
  const payload = decrypted.payload;
  const userId = payload.sub;
  if (typeof userId !== 'string' || !userId.trim()) return { outcome: 'unauthenticated', now };
  const subject = await readLockedWebSubjectState(transaction, userId);
  // Primary state reads can themselves wait on relation locks. Only a NEW DB
  // clock after those waits can qualify this source for the coming verdict.
  const checkedAt = await databaseTime(transaction);
  requireFreshCommand(command.issuedAt, checkedAt);
  try {
    await decryptLegacyWebJwe(command.payload.credential, scope.secret, 15, checkedAt);
  } catch {
    return { outcome: 'unauthenticated', userId, now: checkedAt };
  }
  // Preserve missing/null gen→0 and RAW signed SID denial rules. The display
  // SID/jti/pending identity must never replace the credential's claims.
  if (
    !isCredentialAdmitted(
      decideCredential(
        {
          kind: 'web-session',
          generationClaim: payload.gen,
          sessionKeyClaim: payload.authSessionId,
          authTimeClaim: payload.auth_time,
        },
        subject,
        checkedAt.getTime(),
      ),
      'enforce',
    )
  )
    return { outcome: 'unauthenticated', userId, now: checkedAt };
  const viewer = command.payload.viewer;
  let sameViewer = viewer.userId === userId;
  if (payload.authSessionId) {
    sameViewer &&=
      typeof payload.authSessionId === 'string'
        ? viewer.authSessionId === payload.authSessionId
        : viewer.authSessionId === null;
  } else if (typeof payload.jti === 'string' && payload.jti) sameViewer &&= viewer.authSessionId === payload.jti;
  else
    sameViewer &&=
      typeof viewer.authSessionId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(viewer.authSessionId);
  return { outcome: sameViewer ? 'admitted' : 'identity_changed', userId, now: checkedAt };
}

/** Default compatibility only: no authority receipt, generation change or session issuance. */
export async function setPasswordBeforeEnforcement(
  database: DbInstance,
  input: SetPasswordCompatibilityCommand,
  scope: SetPasswordCompatibilityScope,
  options: { readonly deadline?: number; readonly signal?: AbortSignal } = {},
): Promise<SetPasswordCompatibilityReply> {
  // Own the primitive source/viewer/request fields across every asynchronous wait.
  const command = Object.freeze({
    ...input,
    payload: Object.freeze({ ...input.payload, viewer: Object.freeze({ ...input.payload.viewer }) }),
  });
  const deadline = options.deadline ?? performance.now() + PRIVATE_AUTH_COMMAND_MS;
  const base = {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'set-password',
    requestId: command.requestId,
  } as const;
  revalidateSetPasswordCompatibilityScope(scope);
  requirePrivateCommandBudget(deadline);
  const prepared = await database.transaction(async (transaction) => {
    await privateCommandTransactionSettings(transaction, deadline);
    const context = await capturePreEnforcementContext(transaction);
    const source = await sourceInTransaction(transaction, command, scope);
    const existing = source.userId
      ? await transaction
          .select({ userId: userCredentials.userId })
          .from(userCredentials)
          .where(eq(userCredentials.userId, source.userId))
          .limit(1)
      : [];
    await revalidatePreEnforcementContext(transaction, context);
    revalidateSetPasswordCompatibilityScope(scope);
    return { context, hashRequired: source.outcome === 'admitted' && existing.length === 0 };
  });
  requirePrivateCommandBudget(deadline);
  const passwordHash = prepared.hashRequired ? await hash(command.payload.password, PASSWORD_HASH_COST) : undefined;
  requirePrivateCommandBudget(deadline);
  if (options.signal?.aborted) throw new SetPasswordCompatibilityUnavailable();
  try {
    return await database.transaction(async (transaction): Promise<SetPasswordCompatibilityReply> => {
      await privateCommandTransactionSettings(transaction, deadline);
      await revalidatePreEnforcementContext(transaction, prepared.context);
      revalidateSetPasswordCompatibilityScope(scope);
      const initial = await sourceInTransaction(transaction, command, scope);
      await revalidatePreEnforcementContext(transaction, prepared.context);
      revalidateSetPasswordCompatibilityScope(scope);
      if (initial.outcome !== 'admitted' || !initial.userId)
        throw new SetPasswordRollbackReply({
          ...base,
          outcome: initial.outcome === 'identity_changed' ? 'identity_changed' : 'unauthenticated',
        });
      const lockedUserId = initial.userId;
      const lockedUser = await lockSubjectRow(transaction, lockedUserId);
      if (!lockedUser) {
        await revalidatePreEnforcementContext(transaction, prepared.context);
        revalidateSetPasswordCompatibilityScope(scope);
        throw new SetPasswordRollbackReply({ ...base, outcome: 'unauthenticated' });
      }
      await transaction
        .select({ userId: authSubjectCutoffs.userId })
        .from(authSubjectCutoffs)
        .where(eq(authSubjectCutoffs.userId, lockedUserId))
        .for('update');
      await transaction
        .select({ userId: userCredentials.userId })
        .from(userCredentials)
        .where(eq(userCredentials.userId, lockedUserId))
        .for('update');
      const requireSource = async () => {
        await revalidatePreEnforcementContext(transaction, prepared.context);
        revalidateSetPasswordCompatibilityScope(scope);
        const source = await sourceInTransaction(transaction, command, scope);
        revalidateSetPasswordCompatibilityScope(scope);
        requirePrivateCommandBudget(deadline);
        if (source.outcome !== 'admitted' || !source.userId)
          throw new SetPasswordRollbackReply({
            ...base,
            outcome: source.outcome === 'identity_changed' ? 'identity_changed' : 'unauthenticated',
          });
        // Every nonce/verdict/mutation actor must own these exact outer locks.
        if (source.userId !== lockedUserId) throw new SetPasswordCompatibilityUnavailable();
        return { ...source, userId: source.userId };
      };
      const source = await requireSource();
      // Even an already-set precheck reaches the actual source and nonce checks.
      // Keep this OUTSIDE the mutation savepoint: a committed409 is replayed503.
      if (!(await claimCommand(transaction, command))) {
        await requireSource();
        return { ...base, outcome: 'error', code: 'replayed' };
      }
      const existing = await transaction
        .select({ userId: userCredentials.userId })
        .from(userCredentials)
        .where(eq(userCredentials.userId, source.userId))
        .limit(1);
      if (existing.length > 0) {
        await requireSource();
        return { ...base, outcome: 'already_set' };
      }
      // An uncoordinated writer removed a prechecked password. Never hash under locks.
      if (passwordHash === undefined || options.signal?.aborted) throw new SetPasswordCompatibilityUnavailable();
      await requireSource();
      let insertConflict: Error | undefined;
      let mutationFailure: MutationRollback | undefined;
      let outcome: 'set' | 'already_set' = 'set';
      try {
        await transaction.transaction(async (mutation) => {
          try {
            try {
              await mutation.insert(userCredentials).values({ userId: source.userId, passwordHash });
            } catch (error) {
              if (!credentialInsertConflict(error)) throw error;
              insertConflict = new Error('Credential insert lost its race');
              throw insertConflict;
            }
            revalidateSetPasswordCompatibilityScope(scope);
            if (scope.evidenceEnabled) {
              await recordPasswordChangeEvidence(mutation, source.userId, passwordHash);
              revalidateSetPasswordCompatibilityScope(scope);
            }
            // Carried legacy compatibility defect, NOT new mailbox ownership proof.
            const verifiedAt = await databaseTime(mutation);
            await mutation
              .update(users)
              .set({ emailVerified: verifiedAt, updatedAt: verifiedAt })
              .where(and(eq(users.id, source.userId), isNull(users.emailVerified)));
            revalidateSetPasswordCompatibilityScope(scope);
          } catch (error) {
            if (error === insertConflict) throw error;
            mutationFailure = new MutationRollback(
              error instanceof SetPasswordCompatibilityUnavailable || !getPostgresErrorCode(error)?.startsWith('23')
                ? 'unavailable'
                : 'rolled_back',
            );
            throw mutationFailure;
          }
        });
      } catch (error) {
        // The installed driver rethrows this SAME tag only after ROLLBACK TO ACK.
        // A replacement rollback/connection error is unknown, not a remembered verdict.
        if (insertConflict && error === insertConflict) outcome = 'already_set';
        else if (mutationFailure && error === mutationFailure)
          throw new SetPasswordRollbackReply({ ...base, outcome: 'error', code: mutationFailure.code });
        else throw error;
      }
      await requireSource();
      revalidateSetPasswordCompatibilityScope(scope);
      return { ...base, outcome };
    });
  } catch (error) {
    // An identical callback tag can escape only AFTER actual OUTER ROLLBACK ACK.
    // COMMIT and rollback replacement errors cannot become a correlated500/401/409.
    if (error instanceof SetPasswordRollbackReply) return error.reply;
    throw error;
  }
}
