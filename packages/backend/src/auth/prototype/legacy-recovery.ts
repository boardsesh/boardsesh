import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '@boardsesh/db/auth-prototype';
import { normalizeAccountEmail } from '../normalize-email';
import { createPrototypeAuthority, type PrototypeAuthority, type PrototypeDatabase } from './authority';
import { PROTOTYPE_CONFIGURATION } from './configuration';
import { revokePrototypeUser } from './legacy-bridge';
import { PROTOTYPE_ISSUER } from './oauth-options';
import { ensurePrototypeMigrationEpoch } from './migration-epoch';
import {
  invalidatePrototypeLegacyRecovery,
  prototypeRecoveryCutoffId,
  PROTOTYPE_LEGACY_RECOVERY_PREFIX,
  type PrototypeRecoveryPurpose,
} from './legacy-recovery-state';

export type { PrototypeRecoveryPurpose } from './legacy-recovery-state';
const BINDING_PREFIX = PROTOTYPE_LEGACY_RECOVERY_PREFIX;
const MIGRATION_EPOCH = 'legacy-recovery';
const PURPOSE_LIFETIMES = { 'password-reset': 3600000, 'email-verification': 86400000 } as const;

export interface PrototypeLegacyRecoveryRecord {
  readonly identifier: string;
  readonly token: string;
  readonly expires: Date;
}

export interface PrototypeRecoveryOwnershipEvidence {
  readonly identifier: string;
  readonly storedToken: string;
  readonly originalUserId: string;
  /** Trusted server-side evidence, never supplied by a recovery request. */
  readonly source: 'captured-at-issuance' | 'verified-ownership-resolution';
}

export interface PrototypeLegacyRecoverySnapshot {
  readonly users: readonly { id: string; email: string }[];
  readonly records: readonly PrototypeLegacyRecoveryRecord[];
  readonly ownership: readonly PrototypeRecoveryOwnershipEvidence[];
}

interface RecoveryBinding {
  readonly type: 'prototype-legacy-recovery';
  readonly purpose: PrototypeRecoveryPurpose;
  readonly userId: string;
  readonly emailAtIssuance: string;
  readonly sourceIdentifier: string;
  readonly ownershipSource: PrototypeRecoveryOwnershipEvidence['source'];
  readonly consumedAt: string | null;
  readonly supersededAt: string | null;
}

export class PrototypeLegacyRecoveryError extends Error {
  readonly status = 400;
  constructor() {
    super('Invalid or expired recovery link');
    this.name = 'PrototypeLegacyRecoveryError';
  }
}

function captureCutoverTime(cutoverAt: Date): number {
  const cutoverTime = cutoverAt.getTime();
  if (!Number.isFinite(cutoverTime) || cutoverTime > Date.now()) throw new PrototypeLegacyRecoveryError();
  return cutoverTime;
}

function purposeAndEmail(identifier: string): { purpose: PrototypeRecoveryPurpose; email: string } {
  return identifier.startsWith('password-reset:')
    ? { purpose: 'password-reset', email: identifier.slice('password-reset:'.length) }
    : { purpose: 'email-verification', email: identifier };
}

function lookupIdentifier(purpose: PrototypeRecoveryPurpose, email: string, storedToken: string): string {
  return `${BINDING_PREFIX}${createHash('sha256')
    .update(JSON.stringify([purpose, normalizeAccountEmail(email), storedToken]))
    .digest('hex')}`;
}

function parseBinding(serialized: string): RecoveryBinding | null {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const binding = parsed as Record<string, unknown>;
    if (
      binding.type !== 'prototype-legacy-recovery' ||
      !['password-reset', 'email-verification'].includes(String(binding.purpose)) ||
      typeof binding.userId !== 'string' ||
      typeof binding.emailAtIssuance !== 'string' ||
      typeof binding.sourceIdentifier !== 'string' ||
      !['captured-at-issuance', 'verified-ownership-resolution'].includes(String(binding.ownershipSource)) ||
      !(
        binding.consumedAt === null ||
        (typeof binding.consumedAt === 'string' && Number.isFinite(Date.parse(binding.consumedAt)))
      ) ||
      !(
        binding.supersededAt === null ||
        (typeof binding.supersededAt === 'string' && Number.isFinite(Date.parse(binding.supersededAt)))
      )
    )
      return null;
    return binding as unknown as RecoveryBinding;
  } catch {
    return null;
  }
}

/**
 * Disposable import proof. Legacy rows alone cannot establish their original
 * owner: a trusted issuance snapshot or verified resolution is mandatory.
 * Source rows are not changed; production adoption additionally needs the writer
 * fence so an old handler cannot independently consume those unchanged rows.
 */
export async function bindPrototypeLegacyRecoveryLinks(
  database: PrototypeDatabase,
  snapshot: PrototypeLegacyRecoverySnapshot,
  cutoverAt: Date,
) {
  const cutoverTime = captureCutoverTime(cutoverAt);
  // Snapshot ownership and dates before awaiting the shared lifecycle fence.
  const capturedSnapshot = {
    users: snapshot.users.map((user) => ({ id: user.id, email: user.email })),
    records: snapshot.records.map((record) => ({ ...record, expires: new Date(record.expires.getTime()) })),
    ownership: snapshot.ownership.map((evidence) => ({ ...evidence })),
  };
  const ownersByEmail = new Map<string, readonly { id: string; email: string }[]>();
  for (const user of capturedSnapshot.users) {
    const address = normalizeAccountEmail(user.email);
    ownersByEmail.set(address, [...(ownersByEmail.get(address) ?? []), user]);
  }
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(6975, 1)`);
    if (!(await ensurePrototypeMigrationEpoch(transaction, MIGRATION_EPOCH, cutoverTime)))
      throw new PrototypeLegacyRecoveryError();
    let bound = 0;
    let rejected = 0;
    for (const record of capturedSnapshot.records) {
      const { purpose, email } = purposeAndEmail(record.identifier);
      const emailAtIssuance = normalizeAccountEmail(email);
      const owners = ownersByEmail.get(emailAtIssuance) ?? [];
      const evidence = capturedSnapshot.ownership.filter(
        (candidate) => candidate.identifier === record.identifier && candidate.storedToken === record.token,
      );
      const expiration = record.expires.getTime();
      const validStoredToken =
        purpose === 'password-reset' ? /^[a-f0-9]{64}$/.test(record.token) : z.uuid().safeParse(record.token).success;
      if (
        !validStoredToken ||
        !z.email().safeParse(emailAtIssuance).success ||
        owners.length !== 1 ||
        evidence.length !== 1 ||
        evidence[0].originalUserId !== owners[0].id ||
        !['captured-at-issuance', 'verified-ownership-resolution'].includes(evidence[0].source) ||
        !Number.isFinite(expiration) ||
        expiration <= cutoverTime ||
        expiration > cutoverTime + PURPOSE_LIFETIMES[purpose]
      ) {
        rejected += 1;
        continue;
      }
      const [canonicalUser] = await transaction.select().from(schema.user).where(eq(schema.user.id, owners[0].id));
      if (!canonicalUser || normalizeAccountEmail(canonicalUser.email) !== emailAtIssuance) {
        rejected += 1;
        continue;
      }
      const [superseded] = await transaction
        .select({ id: schema.verification.id })
        .from(schema.verification)
        .where(eq(schema.verification.id, prototypeRecoveryCutoffId(canonicalUser.id, purpose)));
      if (superseded) {
        rejected += 1;
        continue;
      }
      const identifier = lookupIdentifier(purpose, emailAtIssuance, record.token);
      const binding: RecoveryBinding = {
        type: 'prototype-legacy-recovery',
        purpose,
        userId: canonicalUser.id,
        emailAtIssuance,
        sourceIdentifier: record.identifier,
        ownershipSource: evidence[0].source,
        consumedAt: null,
        supersededAt: null,
      };
      await transaction
        .insert(schema.verification)
        .values({
          id: identifier,
          identifier,
          value: JSON.stringify(binding),
          expiresAt: record.expires,
        })
        .onConflictDoNothing();
      const [stored] = await transaction
        .select()
        .from(schema.verification)
        .where(eq(schema.verification.id, identifier));
      const existing = stored ? parseBinding(stored.value) : null;
      if (
        !existing ||
        existing.userId !== binding.userId ||
        existing.purpose !== purpose ||
        existing.emailAtIssuance !== emailAtIssuance ||
        existing.sourceIdentifier !== record.identifier ||
        stored.expiresAt.getTime() !== expiration
      ) {
        rejected += 1;
        continue;
      }
      // Re-import never overwrites consumed/superseded tombstones or extends expiry.
      bound += 1;
    }
    return { bound, rejected };
  });
}

function verificationPlugin(user: typeof schema.user.$inferSelect): BetterAuthPlugin {
  return {
    id: 'boardsesh-disposable-bound-email-verification',
    endpoints: {
      prototypeBoundVerification: createAuthEndpoint(
        '/prototype-bound-email-verification',
        { method: 'POST' },
        async (context) => {
          // The bound user comes from the validated server-held token, never body/email lookup.
          await context.context.internalAdapter.updateUser(user.id, {
            emailVerified: true,
            ...(!user.emailVerified && user.legacyEmailVerifiedAt === null
              ? { legacyEmailVerifiedAt: new Date() }
              : {}),
          });
          return context.json({ status: true });
        },
      ),
    },
  };
}

async function markVerified(authority: PrototypeAuthority): Promise<void> {
  const response = await authority.handler(
    new Request(`${PROTOTYPE_ISSUER}/prototype-bound-email-verification`, {
      method: 'POST',
      headers: { origin: 'https://www.boardsesh.test', 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  if (!response.ok) throw new Error('Canonical email verification failed');
}

/** Same canonical credential writer and revocation transaction; no production route mounts this facade. */
export function createPrototypeLegacyRecoveryFacade(
  database: PrototypeDatabase,
  cutoverAt: Date,
  afterMutation?: () => Promise<void>,
) {
  const cutoverTime = captureCutoverTime(cutoverAt);
  async function consume(purpose: PrototypeRecoveryPurpose, email: string, token: string, password?: string) {
    if (!z.uuid().safeParse(token).success) throw new PrototypeLegacyRecoveryError();
    const storedToken = purpose === 'password-reset' ? createHash('sha256').update(token).digest('hex') : token;
    const identifier = lookupIdentifier(purpose, email, storedToken);
    return database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(6975, 1)`);
      if (!(await ensurePrototypeMigrationEpoch(transaction, MIGRATION_EPOCH, cutoverTime)))
        throw new PrototypeLegacyRecoveryError();
      const [record] = await transaction
        .select()
        .from(schema.verification)
        .where(eq(schema.verification.id, identifier))
        .for('update');
      const binding = record ? parseBinding(record.value) : null;
      const now = Date.now();
      if (
        !binding ||
        binding.purpose !== purpose ||
        binding.consumedAt ||
        binding.supersededAt ||
        record.expiresAt.getTime() <= now ||
        now > cutoverTime + PURPOSE_LIFETIMES[purpose] ||
        record.expiresAt.getTime() > cutoverTime + PURPOSE_LIFETIMES[purpose]
      )
        throw new PrototypeLegacyRecoveryError();
      const [user] = await transaction.select().from(schema.user).where(eq(schema.user.id, binding.userId));
      if (!user || normalizeAccountEmail(user.email) !== binding.emailAtIssuance)
        throw new PrototypeLegacyRecoveryError();
      await transaction
        .update(schema.verification)
        .set({ value: JSON.stringify({ ...binding, consumedAt: new Date().toISOString() }) })
        .where(eq(schema.verification.id, identifier));
      const authority = createPrototypeAuthority(transaction, {
        plugins: [verificationPlugin(user)],
        emailAndPassword: {
          ...PROTOTYPE_CONFIGURATION.emailAndPassword,
          async onPasswordReset({ user: resetUser }) {
            await revokePrototypeUser(transaction, resetUser.id);
          },
        },
      });
      if (purpose === 'password-reset') {
        const translatedToken = randomBytes(32).toString('hex');
        await transaction.insert(schema.verification).values({
          id: randomUUID(),
          identifier: `reset-password:${translatedToken}`,
          value: user.id,
          expiresAt: new Date(Math.min(record.expiresAt.getTime(), now + 60000)),
        });
        // Better Auth owns password validation, bcrypt hashing and credential writes.
        await authority.api.resetPassword({ body: { token: translatedToken, newPassword: password! } });
      }
      await markVerified(authority);
      await invalidatePrototypeLegacyRecovery(transaction, user.id, [purpose]);
      await afterMutation?.();
      return { status: true as const, userId: user.id };
    });
  }
  return {
    resetPassword(request: { email: string; token: string; password: string; confirmPassword: string }) {
      if (request.password !== request.confirmPassword) return Promise.reject(new PrototypeLegacyRecoveryError());
      return consume('password-reset', request.email, request.token, request.password);
    },
    verifyEmail(request: { email: string; token: string }) {
      return consume('email-verification', request.email, request.token);
    },
    supersede(userId: string, purpose: PrototypeRecoveryPurpose) {
      return database.transaction(async (transaction) => {
        await transaction.execute(sql`select pg_advisory_xact_lock(6975, 1)`);
        if (!(await ensurePrototypeMigrationEpoch(transaction, MIGRATION_EPOCH, cutoverTime)))
          throw new PrototypeLegacyRecoveryError();
        await invalidatePrototypeLegacyRecovery(transaction, userId, [purpose]);
      });
    },
  };
}
