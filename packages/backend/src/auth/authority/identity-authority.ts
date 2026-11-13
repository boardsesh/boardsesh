import { randomUUID } from 'node:crypto';
import { accounts, authAccount, authSubjectCutoffs, userCredentials, users } from '@boardsesh/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createAuthorityAdapter, type AuthorityTransaction } from './adapter';
import { revalidateIdentityAuthority, type IdentityAuthorityReceipt } from './router';

export interface IdentityPasswordSnapshot {
  readonly userId: string;
  readonly passwordHash: string;
  readonly generation: number;
}
export interface ProviderIdentity {
  readonly userId: string;
  readonly provider: string;
  readonly subject: string;
}
export interface ProviderIdentitySnapshot extends ProviderIdentity {
  readonly generation: number;
}
export type NewIdentityUser = Pick<
  typeof users.$inferInsert,
  'id' | 'email' | 'name' | 'emailVerified' | 'image' | 'createdAt'
> & { readonly id: string };
export interface IdentityAuthority {
  readonly receipt: IdentityAuthorityReceipt;
  readPassword(userId: string, lock?: 'update'): Promise<IdentityPasswordSnapshot | null>;
  listProviders(userId: string): Promise<readonly ProviderIdentitySnapshot[]>;
  /** Ownership evidence only; callers still enforce the user's deletion/cutoff state. */
  findProvider(provider: string, subject: string, lock?: 'update'): Promise<ProviderIdentitySnapshot | null>;
  createUser(input: NewIdentityUser): Promise<typeof users.$inferSelect>;
  insertPassword(userId: string, passwordHash: string, generation: number): Promise<void>;
  replacePassword(expected: IdentityPasswordSnapshot, passwordHash: string): Promise<boolean>;
  insertProvider(identity: ProviderIdentity, generation: number): Promise<void>;
  removeProvider(identity: ProviderIdentity, generation: number): Promise<boolean>;
  verifyEmail(userId: string, expectedEmail: string, generation: number, verifiedAt: Date): Promise<void>;
  deleteUser(userId: string): Promise<boolean>;
}
interface CanonicalAccount {
  id: string;
  userId: string;
  providerId: string;
  accountId: string;
  password: string | null;
  sourceGeneration: number | null;
}
const MAX_PROVIDER_INVENTORY_ROWS = 1000;

function generationIsValid(generation: unknown): generation is number {
  return (
    typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0 && generation <= 2_147_483_647
  );
}
function assertProvider(provider: string, subject: string): void {
  if (!provider || provider === 'credential' || !subject) throw new Error('IDENTITY_PROVIDER_NAMESPACE_INVALID');
}

/**
 * The adapter performs primary Better Auth user/account operations. It has no
 * route, session creation, OAuth plugin, independent transaction, or logging.
 * Callers retain domain policy and the final same-transaction reverse mirror.
 */
export function bindIdentityAuthority(
  transaction: AuthorityTransaction,
  input: IdentityAuthorityReceipt,
): IdentityAuthority {
  const receipt = Object.freeze({ ...input });
  const betterAuth =
    receipt.authority === 'better-auth'
      ? createAuthorityAdapter(transaction)({ logger: { disabled: true }, telemetry: { enabled: false } })
      : undefined;

  async function lockUser(userId: string, expectedGeneration?: number, allowDeleted = false): Promise<boolean> {
    await revalidateIdentityAuthority(transaction, receipt);
    const [user] = await transaction.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    if (!user) return false;
    const [cutoff] = await transaction
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, userId))
      .for('update');
    if (cutoff?.deletedAt && !allowDeleted) throw new Error('IDENTITY_SUBJECT_DELETED');
    if (
      expectedGeneration !== undefined &&
      (!generationIsValid(expectedGeneration) || (cutoff?.generation ?? 0) !== expectedGeneration)
    )
      throw new Error('IDENTITY_GENERATION_STALE');
    return true;
  }
  async function canonicalPassword(userId: string): Promise<CanonicalAccount | null> {
    if (!betterAuth) throw new Error('IDENTITY_AUTHORITY_MISMATCH');
    const found = await betterAuth.findMany<CanonicalAccount>({
      model: 'account',
      where: [
        { field: 'userId', value: userId },
        { field: 'providerId', value: 'credential' },
      ],
    });
    if (found.length > 1 || (found[0] && found[0].accountId !== userId))
      throw new Error('IDENTITY_CREDENTIAL_AMBIGUOUS');
    return found[0] ?? null;
  }
  return {
    receipt,
    async readPassword(userId, lock) {
      await revalidateIdentityAuthority(transaction, receipt);
      if (betterAuth) {
        if (lock === 'update')
          await transaction
            .select({ id: authAccount.id })
            .from(authAccount)
            .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, 'credential')))
            .for('update');
        // Both fields come from ONE adapter SELECT, never a later cutoff read.
        const credential = await canonicalPassword(userId);
        if (!credential) return null;
        if (typeof credential.password !== 'string' || !generationIsValid(credential.sourceGeneration))
          throw new Error('IDENTITY_CREDENTIAL_UNQUALIFIED');
        return { userId, passwordHash: credential.password, generation: credential.sourceGeneration };
      }
      const query = transaction
        .select({
          passwordHash: userCredentials.passwordHash,
          generation: sql<number>`coalesce(${authSubjectCutoffs.generation}, 0)::integer`,
          deletedAt: authSubjectCutoffs.deletedAt,
        })
        .from(userCredentials)
        .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, userCredentials.userId))
        .where(eq(userCredentials.userId, userId));
      const [credential] = await (lock === 'update' ? query.for('update', { of: userCredentials }) : query);
      if (!credential || credential.deletedAt) return null;
      return { userId, passwordHash: credential.passwordHash, generation: credential.generation };
    },
    async findProvider(provider, subject, lock) {
      assertProvider(provider, subject);
      await revalidateIdentityAuthority(transaction, receipt);
      if (betterAuth) {
        // The caller takes the user lock first. Waiting on this primary row
        // prevents an uncommitted unfenced owner change from hiding behind an
        // older MVCC snapshot; the adapter then reads the committed owner.
        if (lock === 'update')
          await transaction
            .select({ id: authAccount.id })
            .from(authAccount)
            .where(and(eq(authAccount.providerId, provider), eq(authAccount.accountId, subject)))
            .for('update');
        const found = await betterAuth.findOne<CanonicalAccount>({
          model: 'account',
          where: [
            { field: 'providerId', value: provider },
            { field: 'accountId', value: subject },
          ],
        });
        if (!found) return null;
        if (!generationIsValid(found.sourceGeneration)) throw new Error('IDENTITY_PROVIDER_UNQUALIFIED');
        return { userId: found.userId, provider, subject, generation: found.sourceGeneration };
      }
      const query = transaction
        .select({
          userId: accounts.userId,
          generation: sql<number>`coalesce(${authSubjectCutoffs.generation}, 0)::integer`,
        })
        .from(accounts)
        .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, accounts.userId))
        .where(and(eq(accounts.provider, provider), eq(accounts.providerAccountId, subject)));
      const [found] = await (lock === 'update' ? query.for('update', { of: accounts }) : query);
      return found ? { userId: found.userId, provider, subject, generation: found.generation } : null;
    },
    async listProviders(userId) {
      await revalidateIdentityAuthority(transaction, receipt);
      if (betterAuth) {
        const linked = await betterAuth.findMany<CanonicalAccount>({
          model: 'account',
          where: [
            { field: 'userId', value: userId },
            { field: 'providerId', operator: 'ne', value: 'credential' },
          ],
          // BA defaults to 100. A partial inventory cannot establish that an
          // unlink leaves a usable method. Oversized inventories refuse.
          limit: MAX_PROVIDER_INVENTORY_ROWS + 1,
        });
        if (linked.length > MAX_PROVIDER_INVENTORY_ROWS) throw new Error('IDENTITY_PROVIDER_INVENTORY_UNAVAILABLE');
        return linked
          .filter((account) => account.providerId !== 'credential')
          .map((account) => {
            assertProvider(account.providerId, account.accountId);
            if (account.userId !== userId || !generationIsValid(account.sourceGeneration))
              throw new Error('IDENTITY_PROVIDER_UNQUALIFIED');
            return {
              userId,
              provider: account.providerId,
              subject: account.accountId,
              generation: account.sourceGeneration,
            };
          });
      }
      const linked = await transaction
        .select({
          userId: accounts.userId,
          provider: accounts.provider,
          subject: accounts.providerAccountId,
          generation: sql<number>`coalesce(${authSubjectCutoffs.generation}, 0)::integer`,
        })
        .from(accounts)
        .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, accounts.userId))
        .where(eq(accounts.userId, userId))
        .limit(MAX_PROVIDER_INVENTORY_ROWS + 1);
      if (linked.length > MAX_PROVIDER_INVENTORY_ROWS) throw new Error('IDENTITY_PROVIDER_INVENTORY_UNAVAILABLE');
      return linked;
    },
    async createUser(input) {
      const prepared = {
        ...input,
        createdAt: input.createdAt ? new Date(input.createdAt) : new Date(),
        emailVerified: input.emailVerified ? new Date(input.emailVerified) : null,
      };
      await revalidateIdentityAuthority(transaction, receipt);
      if (betterAuth) {
        await betterAuth.create({
          model: 'user',
          forceAllowId: true,
          data: {
            ...prepared,
            name: prepared.name ?? '',
            emailVerified: false,
          },
        });
        // The one shared users row retains trusted nullable name and exact
        // verification timestamp; no boolean conversion may invent evidence.
        await transaction
          .update(users)
          .set({ name: prepared.name ?? null, emailVerified: prepared.emailVerified })
          .where(eq(users.id, prepared.id));
      } else await transaction.insert(users).values(prepared);
      const [created] = await transaction.select().from(users).where(eq(users.id, prepared.id));
      if (!created) throw new Error('IDENTITY_USER_CREATE_FAILED');
      return created;
    },
    async insertPassword(userId, passwordHash, generation) {
      if (!(await lockUser(userId, generation))) throw new Error('IDENTITY_SUBJECT_MISSING');
      if (betterAuth)
        await betterAuth.create({
          model: 'account',
          forceAllowId: true,
          data: {
            id: randomUUID(),
            userId,
            providerId: 'credential',
            accountId: userId,
            password: passwordHash,
            sourceGeneration: generation,
          },
        });
      else await transaction.insert(userCredentials).values({ userId, passwordHash });
    },
    async replacePassword(expected, passwordHash) {
      const prepared = { ...expected };
      if (!(await lockUser(prepared.userId, prepared.generation))) return false;
      if (betterAuth) {
        const changed = await betterAuth.update<CanonicalAccount>({
          model: 'account',
          where: [
            { field: 'userId', value: prepared.userId },
            { field: 'providerId', value: 'credential' },
            { field: 'accountId', value: prepared.userId },
            { field: 'password', value: prepared.passwordHash },
            { field: 'sourceGeneration', value: prepared.generation },
          ],
          update: { password: passwordHash },
        });
        return Boolean(changed);
      }
      const changed = await transaction
        .update(userCredentials)
        .set({ passwordHash, updatedAt: new Date() })
        .where(
          and(eq(userCredentials.userId, prepared.userId), eq(userCredentials.passwordHash, prepared.passwordHash)),
        )
        .returning({ userId: userCredentials.userId });
      return changed.length === 1;
    },
    async insertProvider(identity, generation) {
      const prepared = { ...identity };
      assertProvider(prepared.provider, prepared.subject);
      if (!(await lockUser(prepared.userId, generation))) throw new Error('IDENTITY_SUBJECT_MISSING');
      if (betterAuth)
        await betterAuth.create({
          model: 'account',
          forceAllowId: true,
          data: {
            id: randomUUID(),
            userId: prepared.userId,
            providerId: prepared.provider,
            accountId: prepared.subject,
            sourceGeneration: generation,
          },
        });
      else
        await transaction.insert(accounts).values({
          userId: prepared.userId,
          type: 'oauth',
          provider: prepared.provider,
          providerAccountId: prepared.subject,
        });
    },
    async removeProvider(identity, generation) {
      const prepared = { ...identity };
      assertProvider(prepared.provider, prepared.subject);
      if (!(await lockUser(prepared.userId, generation))) return false;
      if (betterAuth)
        return (
          (await betterAuth.deleteMany({
            model: 'account',
            where: [
              { field: 'userId', value: prepared.userId },
              { field: 'providerId', value: prepared.provider },
              { field: 'accountId', value: prepared.subject },
            ],
          })) === 1
        );
      const removed = await transaction
        .delete(accounts)
        .where(
          and(
            eq(accounts.userId, prepared.userId),
            eq(accounts.provider, prepared.provider),
            eq(accounts.providerAccountId, prepared.subject),
          ),
        )
        .returning({ userId: accounts.userId });
      return removed.length === 1;
    },
    async verifyEmail(userId, expectedEmail, generation, requestedVerifiedAt) {
      const verifiedAt = new Date(requestedVerifiedAt.getTime());
      if (!Number.isFinite(verifiedAt.getTime())) throw new Error('IDENTITY_VERIFICATION_TIME_INVALID');
      if (!(await lockUser(userId, generation))) throw new Error('IDENTITY_SUBJECT_MISSING');
      const [user] = await transaction.select().from(users).where(eq(users.id, userId));
      if (!user || user.email !== expectedEmail) throw new Error('IDENTITY_VERIFICATION_ADDRESS_CHANGED');
      if (user.emailVerified) return;
      if (betterAuth) {
        const changed = await betterAuth.update({
          model: 'user',
          where: [
            { field: 'id', value: userId },
            { field: 'email', value: expectedEmail },
            { field: 'emailVerified', value: false },
          ],
          update: { emailVerified: true },
        });
        if (!changed) throw new Error('IDENTITY_VERIFICATION_SOURCE_CHANGED');
      }
      // The shared users row stores the exact receipt clock, while Better Auth
      // exposes a boolean. As on createUser, restore the trusted timestamp after
      // that adapter conversion in this same transaction; never refresh an
      // already verified timestamp.
      const [verified] = await transaction
        .update(users)
        .set({ emailVerified: verifiedAt })
        .where(
          and(
            eq(users.id, userId),
            eq(users.email, expectedEmail),
            betterAuth ? undefined : isNull(users.emailVerified),
          ),
        )
        .returning({ verifiedAt: users.emailVerified });
      if (verified?.verifiedAt?.getTime() !== verifiedAt.getTime())
        throw new Error('IDENTITY_VERIFICATION_SOURCE_CHANGED');
      await revalidateIdentityAuthority(transaction, receipt);
    },
    async deleteUser(userId) {
      if (!(await lockUser(userId, undefined, true))) return false;
      if (betterAuth) await betterAuth.delete({ model: 'user', where: [{ field: 'id', value: userId }] });
      else await transaction.delete(users).where(eq(users.id, userId));
      return true;
    },
  };
}
