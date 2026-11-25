import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_PROTOCOL_VERSION,
  LEGACY_PASSWORD_RESET_LIFETIME_MS,
  legacyLinkAccount,
  isVersionedPasswordRecoveryToken,
  passwordRecoveryTokenSchema,
  type ForgotPasswordCommand,
  type ForgotPasswordReply,
  type ResetPasswordCommand,
  type ResetPasswordReply,
} from '@boardsesh/auth-protocol';
import { PASSWORD_HASH_COST } from '@boardsesh/auth-protocol/password-hash';
import {
  ACCOUNT_EMAIL_CANDIDATE_LIMIT,
  normalizeAccountEmail,
  resolveAccountEmail,
  soleAccount,
} from '@boardsesh/auth-protocol/account-email';
import { accountEmailCandidates } from '@boardsesh/db/queries/account-email';
import {
  authPasswordRecoveryState,
  authPasswordRecoveryTokens,
  authSubjectCutoffs,
  mobileRefreshTokens,
  userCredentials,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { mintNativeDeviceToken } from '../device-token';
import { passwordGuessLimiter } from '../password-guess-limit';
import { recordPasswordChangeEvidence } from '../password-change-evidence';
import { mirrorIdentityIfEnabled } from '../authority/sync-identity';
import { assertFresh, claimCommand } from './command-context';
import { registrationEmailHolders } from './registration-context';
import {
  CurrentStoreFoundationError,
  lockEmailKeyForCreation,
  type CurrentStoreTransaction,
} from './foundation-context';
import { capturePreEnforcementContext, revalidatePreEnforcementContext } from './pre-enforcement-context';
import {
  PRIVATE_AUTH_COMMAND_MS,
  privateCommandTransactionSettings,
  requirePrivateCommandBudget,
} from './private-command-budget';
import { recordPreEnforcementPasswordReset } from './pre-enforcement-reset-mutation';
import {
  PASSWORD_RECOVERY_PURPOSE,
  recoveryClock,
  issueUidPasswordRecoveryReceipt,
  readUidPasswordRecoveryReceipt,
  samePasswordRecoveryBinding,
  consumeUidPasswordRecoveryReceipt,
  type PasswordRecoveryReceipt,
} from './password-recovery-receipts';

const emailSchema = z.string().email('Invalid email address');
const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be less than 128 characters');
const forgotSchema = z.object({ email: emailSchema });
const legacyResetSchema = z
  .object({
    email: emailSchema,
    token: z.string().uuid('Invalid reset token'),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((body) => body.password === body.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
const uidResetSchema = z
  .object({
    email: z.unknown().optional(),
    token: z.string().min(1, 'Invalid reset token').max(256, 'Invalid reset token'),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((body) => body.password === body.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

async function recoveryCandidates(transaction: CurrentStoreTransaction, address: string) {
  const candidates = await transaction
    .select({
      id: users.id,
      email: users.email,
      createdAt: users.createdAt,
      emailVerified: users.emailVerified,
      passwordHash: userCredentials.passwordHash,
      generation: sql<number>`coalesce(${authSubjectCutoffs.generation}, 0)::integer`,
      deletedAt: authSubjectCutoffs.deletedAt,
    })
    .from(users)
    .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
    .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, users.id))
    .where(accountEmailCandidates(address))
    .orderBy(users.id)
    .limit(ACCOUNT_EMAIL_CANDIDATE_LIMIT + 1);
  return candidates.map((candidate) => ({ ...candidate, createdAt: new Date(candidate.createdAt.getTime()) }));
}
type Candidate = Awaited<ReturnType<typeof recoveryCandidates>>[number];
/** New UID capabilities require actual JS-normalized sole membership, before cleanup. */
async function soleNormalizedRecoveryOwner(transaction: CurrentStoreTransaction, address: string, userId: string) {
  const holders = await registrationEmailHolders(transaction, normalizeAccountEmail(address));
  return holders.length === 1 && holders[0].id === userId;
}

function sameCandidates(before: readonly Candidate[], after: readonly Candidate[]) {
  return (
    before.length === after.length &&
    before.length <= ACCOUNT_EMAIL_CANDIDATE_LIMIT &&
    before.every((candidate, index) => {
      const current = after[index];
      return (
        current?.id === candidate.id &&
        current.email === candidate.email &&
        current.passwordHash === candidate.passwordHash &&
        current.generation === candidate.generation &&
        Boolean(current.deletedAt) === Boolean(candidate.deletedAt) &&
        current.createdAt.getTime() === candidate.createdAt.getTime()
      );
    })
  );
}
async function lockCandidates(transaction: CurrentStoreTransaction, candidates: readonly Candidate[]) {
  await transaction
    .select({ id: users.id })
    .from(users)
    .where(
      inArray(
        users.id,
        candidates.map((candidate) => candidate.id),
      ),
    )
    .orderBy(users.id)
    .for('update');
}
async function lockCutoffAndCredential(transaction: CurrentStoreTransaction, userId: string) {
  await transaction
    .select({ userId: authSubjectCutoffs.userId })
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, userId))
    .for('update');
  await transaction
    .select({ userId: userCredentials.userId })
    .from(userCredentials)
    .where(eq(userCredentials.userId, userId))
    .for('update');
}

/** The default issuer is not adopted by this PR; only private capable callers use it. */
export async function requestRecoveryBeforeEnforcement(
  database: DbInstance,
  input: ForgotPasswordCommand,
  deadline = performance.now() + PRIVATE_AUTH_COMMAND_MS,
): Promise<ForgotPasswordReply> {
  const { requestId, issuedAt } = input;
  const parsed = forgotSchema.safeParse(input.payload);
  const email = parsed.success ? parsed.data.email : undefined;
  const base = { protocolVersion: AUTH_PROTOCOL_VERSION, operation: 'forgot-password', requestId } as const;
  return database.transaction(async (transaction): Promise<ForgotPasswordReply> => {
    await privateCommandTransactionSettings(transaction, deadline);
    try {
      const context = await capturePreEnforcementContext(transaction);
      if (!(await claimCommand(transaction, { operation: 'forgot-password', requestId, issuedAt })))
        return { ...base, outcome: 'error', code: 'replayed' };
      assertFresh(issuedAt);
      if (!email || !parsed.success)
        return {
          ...base,
          outcome: 'error',
          code: 'validation_error',
          message: parsed.success
            ? 'Invalid email address'
            : (parsed.error.issues[0].message as Extract<ForgotPasswordReply, { code: 'validation_error' }>['message']),
        };
      await lockEmailKeyForCreation(transaction, normalizeAccountEmail(email));
      const initial = await recoveryCandidates(transaction, email);
      const account = soleAccount(resolveAccountEmail(email, initial));
      if (
        !account ||
        account.passwordHash === null ||
        account.deletedAt ||
        !(await soleNormalizedRecoveryOwner(transaction, email, account.id))
      ) {
        assertFresh(issuedAt);
        requirePrivateCommandBudget(deadline);
        return { ...base, outcome: 'accepted' };
      }
      await lockCandidates(transaction, initial);
      await lockCutoffAndCredential(transaction, account.id);
      const current = await recoveryCandidates(transaction, email);
      if (!sameCandidates(initial, current)) throw new CurrentStoreFoundationError('STALE_GENERATION');
      const user = soleAccount(resolveAccountEmail(email, current));
      if (
        !user ||
        user.deletedAt ||
        !user.passwordHash ||
        !emailSchema.safeParse(user.email).success ||
        !(await soleNormalizedRecoveryOwner(transaction, email, user.id))
      )
        return { ...base, outcome: 'accepted' };
      const mailPlan = await issueUidPasswordRecoveryReceipt(transaction, {
        userId: user.id,
        deliveredEmail: user.email,
        normalizedEmail: normalizeAccountEmail(user.email),
        subjectGeneration: user.generation,
      });
      await revalidatePreEnforcementContext(transaction, context);
      assertFresh(issuedAt);
      requirePrivateCommandBudget(deadline);
      return { ...base, outcome: 'accepted', mailPlan };
    } finally {
      assertFresh(issuedAt);
      requirePrivateCommandBudget(deadline);
    }
  });
}

interface LegacyBinding {
  readonly kind: 'legacy';
  readonly identifier: string;
  readonly tokenHash: string;
  readonly expires: Date;
  /** PostgreSQL microseconds are preserved independently of JavaScript Date. */
  readonly exactDeadline: string;
}
interface UidBinding {
  readonly kind: 'uid';
  readonly receipt: PasswordRecoveryReceipt;
}
interface ResetPreview {
  readonly address: string;
  readonly candidates: readonly Candidate[];
  readonly account: Candidate;
  readonly binding: LegacyBinding | UidBinding;
}
async function readLegacyLink(transaction: CurrentStoreTransaction, identifier: string, tokenHash: string) {
  const [link] = await transaction
    .select({
      expires: verificationTokens.expires,
      exactDeadline: sql<string>`to_char(${verificationTokens.expires}, 'YYYY-MM-DD HH24:MI:SS.US')`,
      live: sql<boolean>`${verificationTokens.expires} > (clock_timestamp() AT TIME ZONE 'UTC')`,
    })
    .from(verificationTokens)
    .where(and(eq(verificationTokens.identifier, identifier), eq(verificationTokens.token, tokenHash)));
  return link;
}
async function previewReset(
  transaction: CurrentStoreTransaction,
  token: string,
  email: unknown,
  versioned: boolean,
): Promise<ResetPreview | undefined> {
  if (versioned) {
    if (!passwordRecoveryTokenSchema.safeParse(token).success) return;
    const receipt = await readUidPasswordRecoveryReceipt(transaction, token);
    if (
      !receipt ||
      receipt.purpose !== PASSWORD_RECOVERY_PURPOSE ||
      receipt.consumedAt ||
      receipt.supersededAt ||
      receipt.expiresAt.getTime() <= (await recoveryClock(transaction))
    )
      return;
    const [owner] = await transaction.select({ email: users.email }).from(users).where(eq(users.id, receipt.userId));
    if (
      !owner ||
      normalizeAccountEmail(owner.email) !== receipt.normalizedEmail ||
      normalizeAccountEmail(receipt.deliveredEmail) !== receipt.normalizedEmail
    )
      return;
    const candidates = await recoveryCandidates(transaction, owner.email);
    const account = soleAccount(resolveAccountEmail(owner.email, candidates));
    if (
      !account ||
      account.id !== receipt.userId ||
      account.passwordHash === null ||
      account.deletedAt ||
      account.generation !== receipt.subjectGeneration ||
      !(await soleNormalizedRecoveryOwner(transaction, owner.email, receipt.userId))
    )
      return;
    return { address: owner.email, candidates, account, binding: { kind: 'uid', receipt } };
  }
  if (typeof email !== 'string') return;
  const identifier = `password-reset:${email}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const link = await readLegacyLink(transaction, identifier, tokenHash);
  if (!link?.live) return;
  const candidates = await recoveryCandidates(transaction, email);
  const account = legacyLinkAccount(resolveAccountEmail(email, candidates), {
    expires: link.expires,
    lifetimeMs: LEGACY_PASSWORD_RESET_LIFETIME_MS,
  });
  if (!account || account.deletedAt) return;
  return {
    address: email,
    candidates,
    account,
    binding: {
      kind: 'legacy',
      identifier,
      tokenHash,
      expires: new Date(link.expires.getTime()),
      exactDeadline: link.exactDeadline,
    },
  };
}

async function consumeLegacyLink(transaction: CurrentStoreTransaction, preview: ResetPreview, binding: LegacyBinding) {
  const predicate = and(
    eq(verificationTokens.identifier, binding.identifier),
    eq(verificationTokens.token, binding.tokenHash),
  );
  await transaction.select({ token: verificationTokens.token }).from(verificationTokens).where(predicate).for('update');
  const current = await readLegacyLink(transaction, binding.identifier, binding.tokenHash);
  if (!current?.live || current.exactDeadline !== binding.exactDeadline) return null;
  const candidates = await recoveryCandidates(transaction, preview.address);
  const account = legacyLinkAccount(resolveAccountEmail(preview.address, candidates), {
    expires: current.expires,
    lifetimeMs: LEGACY_PASSWORD_RESET_LIFETIME_MS,
  });
  if (!account || account.id !== preview.account.id || account.email !== preview.address || account.deletedAt)
    return null;
  if (!sameCandidates(preview.candidates, candidates)) throw new CurrentStoreFoundationError('STALE_GENERATION');
  const [consumed] = await transaction
    .delete(verificationTokens)
    .where(
      and(
        predicate,
        sql`${verificationTokens.expires} = ${binding.exactDeadline}::timestamp`,
        sql`${verificationTokens.expires} > (clock_timestamp() AT TIME ZONE 'UTC')`,
      ),
    )
    .returning({ token: verificationTokens.token });
  return consumed ? new Date(await recoveryClock(transaction)) : null;
}
async function consumeUidLink(transaction: CurrentStoreTransaction, preview: ResetPreview, binding: UidBinding) {
  const initial = binding.receipt;
  await transaction
    .select({ userId: authPasswordRecoveryState.userId })
    .from(authPasswordRecoveryState)
    .where(
      and(
        eq(authPasswordRecoveryState.userId, initial.userId),
        eq(authPasswordRecoveryState.purpose, PASSWORD_RECOVERY_PURPOSE),
      ),
    )
    .for('update');
  await transaction
    .select({ tokenHash: authPasswordRecoveryTokens.tokenHash })
    .from(authPasswordRecoveryTokens)
    .where(eq(authPasswordRecoveryTokens.tokenHash, initial.tokenHash))
    .for('update');
  const [state] = await transaction
    .select()
    .from(authPasswordRecoveryState)
    .where(
      and(
        eq(authPasswordRecoveryState.userId, initial.userId),
        eq(authPasswordRecoveryState.purpose, PASSWORD_RECOVERY_PURPOSE),
      ),
    );
  const [receipt] = await transaction
    .select()
    .from(authPasswordRecoveryTokens)
    .where(eq(authPasswordRecoveryTokens.tokenHash, initial.tokenHash));
  const candidates = await recoveryCandidates(transaction, preview.address);
  const account = soleAccount(resolveAccountEmail(preview.address, candidates));
  if (
    !receipt ||
    !samePasswordRecoveryBinding(initial, receipt) ||
    receipt.consumedAt ||
    receipt.supersededAt ||
    !state ||
    state.generation !== receipt.issuanceGeneration ||
    receipt.expiresAt.getTime() <= (await recoveryClock(transaction)) ||
    !account ||
    account.id !== receipt.userId ||
    account.deletedAt ||
    account.generation !== receipt.subjectGeneration ||
    normalizeAccountEmail(account.email) !== receipt.normalizedEmail ||
    normalizeAccountEmail(receipt.deliveredEmail) !== receipt.normalizedEmail ||
    !(await soleNormalizedRecoveryOwner(transaction, preview.address, receipt.userId))
  )
    return null;
  if (!sameCandidates(preview.candidates, candidates)) throw new CurrentStoreFoundationError('STALE_GENERATION');
  return consumeUidPasswordRecoveryReceipt(transaction, receipt);
}

/** Preserves legacy UUID compatibility; it never imports an original owner or authenticates a session. */
export async function consumeRecoveryBeforeEnforcement(
  database: DbInstance,
  input: ResetPasswordCommand,
  options: { readonly issueDeviceToken?: boolean; readonly deadline?: number } = {},
): Promise<ResetPasswordReply> {
  const deadline = options.deadline ?? performance.now() + PRIVATE_AUTH_COMMAND_MS;
  const { requestId, issuedAt } = input;
  const rawToken: unknown =
    input.payload && typeof input.payload === 'object' && 'token' in input.payload ? input.payload.token : undefined;
  const versioned = isVersionedPasswordRecoveryToken(rawToken);
  const unsupported =
    typeof rawToken === 'string' && (rawToken.length > 256 || (versioned && !/^pr1_/i.test(rawToken)));
  const parsed = (versioned ? uidResetSchema : legacyResetSchema).safeParse(input.payload);
  const body = parsed.success ? { ...parsed.data } : undefined;
  const prepared = await database.transaction(async (transaction) => {
    await privateCommandTransactionSettings(transaction, deadline);
    const context = await capturePreEnforcementContext(transaction);
    const preview =
      body && !unsupported ? await previewReset(transaction, body.token, body.email, versioned) : undefined;
    return { context, preview };
  });
  requirePrivateCommandBudget(deadline);
  const passwordHash = body && prepared.preview ? await bcrypt.hash(body.password, PASSWORD_HASH_COST) : undefined;
  requirePrivateCommandBudget(deadline);
  const base = { protocolVersion: AUTH_PROTOCOL_VERSION, operation: 'reset-password', requestId } as const;
  let resetAccount: Candidate | undefined;
  const reply = await database.transaction(async (transaction): Promise<ResetPasswordReply> => {
    await privateCommandTransactionSettings(transaction, deadline);
    try {
      await revalidatePreEnforcementContext(transaction, prepared.context);
      if (!(await claimCommand(transaction, { operation: 'reset-password', requestId, issuedAt })))
        return { ...base, outcome: 'error', code: 'replayed' };
      assertFresh(issuedAt);
      if (unsupported) return { ...base, outcome: 'error', code: 'unavailable' };
      if (!body || !parsed.success)
        return {
          ...base,
          outcome: 'error',
          code: 'validation_error',
          message: parsed.success
            ? 'Invalid reset token'
            : (parsed.error.issues[0].message as Extract<ResetPasswordReply, { code: 'validation_error' }>['message']),
        };
      const preview = prepared.preview;
      if (!preview || !passwordHash) return { ...base, outcome: 'invalid_or_expired' };
      await lockEmailKeyForCreation(transaction, normalizeAccountEmail(preview.address));
      await lockCandidates(transaction, preview.candidates);
      await lockCutoffAndCredential(transaction, preview.account.id);
      const consumedAt =
        preview.binding.kind === 'legacy'
          ? await consumeLegacyLink(transaction, preview, preview.binding)
          : await consumeUidLink(transaction, preview, preview.binding);
      if (!consumedAt) return { ...base, outcome: 'invalid_or_expired' };
      const current = await recoveryCandidates(transaction, preview.address);
      if (!sameCandidates(preview.candidates, current)) throw new CurrentStoreFoundationError('STALE_GENERATION');
      const account = current.find((candidate) => candidate.id === preview.account.id);
      if (!account || account.deletedAt) throw new CurrentStoreFoundationError('SUBJECT_DELETED');
      const changed =
        account.passwordHash === null
          ? await transaction
              .insert(userCredentials)
              .values({ userId: account.id, passwordHash })
              .onConflictDoNothing()
              .returning({ userId: userCredentials.userId })
          : await transaction
              .update(userCredentials)
              .set({ passwordHash, updatedAt: consumedAt })
              .where(
                and(eq(userCredentials.userId, account.id), eq(userCredentials.passwordHash, account.passwordHash)),
              )
              .returning({ userId: userCredentials.userId });
      if (changed.length !== 1) throw new CurrentStoreFoundationError('STALE_GENERATION');
      await recordPasswordChangeEvidence(transaction, account.id, passwordHash);
      await transaction
        .update(users)
        .set({ emailVerified: consumedAt, updatedAt: consumedAt })
        .where(and(eq(users.id, account.id), isNull(users.emailVerified)));
      // This is the released reset invalidation scope; forgot never deletes legacy links.
      await transaction
        .delete(verificationTokens)
        .where(eq(verificationTokens.identifier, `password-reset:${account.email}`));
      await recordPreEnforcementPasswordReset(transaction, prepared.context, {
        operationId: requestId,
        userId: account.id,
        expectedGeneration: account.generation,
      });
      await transaction
        .update(mobileRefreshTokens)
        .set({ revokedAt: consumedAt })
        .where(and(eq(mobileRefreshTokens.userId, account.id), isNull(mobileRefreshTokens.revokedAt)));
      await mirrorIdentityIfEnabled(transaction, account.id);
      await revalidatePreEnforcementContext(transaction, prepared.context);
      assertFresh(issuedAt);
      requirePrivateCommandBudget(deadline);
      resetAccount = account;
      return { ...base, outcome: 'reset' };
    } finally {
      assertFresh(issuedAt);
      requirePrivateCommandBudget(deadline);
    }
  });
  if (reply.outcome === 'reset' && resetAccount) {
    try {
      await passwordGuessLimiter().clearEmail(resetAccount.email);
    } catch {
      /* A committed reset stays successful. */
    }
    if (options.issueDeviceToken) {
      try {
        const deviceToken = await mintNativeDeviceToken(resetAccount.id);
        if (deviceToken) return { ...reply, deviceToken };
      } catch {
        /* Recognition is optional; it grants no login or authentication age. */
      }
    }
  }
  return reply;
}
