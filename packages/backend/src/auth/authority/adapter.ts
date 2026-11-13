import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import type { BetterAuthOptions } from 'better-auth';
import { sql } from 'drizzle-orm';
import { users, authAccount, authSession, authVerification } from '@boardsesh/db/schema';
import type { DbInstance } from '@boardsesh/db/client';

export const authoritySchema = {
  user: users,
  account: authAccount,
  session: authSession,
  verification: authVerification,
};
export type AuthorityDatabase = DbInstance;
export type AuthorityTransaction = Parameters<Parameters<AuthorityDatabase['transaction']>[0]>[0];
type Adapter = ReturnType<ReturnType<typeof drizzleAdapter>>;
type Where = Parameters<Adapter['findOne']>[0]['where'][number];

function storageWhere(model: string, where: Where[]): Where[] {
  if (model !== 'user') return where;
  return where.map((predicate): Where => {
    if (predicate.field !== 'emailVerified') return predicate;
    if (typeof predicate.value !== 'boolean' || !['eq', 'ne'].includes(predicate.operator ?? 'eq')) {
      throw new Error('AUTHORITY_VERIFICATION_PREDICATE_UNSUPPORTED');
    }
    const equality = (predicate.operator ?? 'eq') === 'eq';
    return { ...predicate, value: null, operator: predicate.value === equality ? 'ne' : 'eq' };
  });
}

function normalizedEmail(email: unknown): void {
  if (typeof email === 'string' && email !== email.trim().toLowerCase()) {
    throw new Error('AUTHORITY_EMAIL_NORMALIZATION_REQUIRED');
  }
}

/** This boundary is the only boolean/timestamp conversion. Never hand BA a Date as a boolean. */
function readUser(record: unknown): unknown {
  if (record === null || typeof record !== 'object') return record;
  const user = record as Record<string, unknown>;
  normalizedEmail(user.email);
  if ('emailVerified' in user && user.emailVerified !== null && !(user.emailVerified instanceof Date)) {
    throw new Error('AUTHORITY_INVALID_VERIFICATION_TIMESTAMP');
  }
  return {
    ...user,
    ...('name' in user ? { name: user.name ?? '' } : {}),
    ...('emailVerified' in user ? { emailVerified: user.emailVerified instanceof Date } : {}),
  };
}

function readResult(model: string, record: unknown): unknown {
  if (model === 'user') return readUser(record);
  if (record === null || typeof record !== 'object') return record;
  const result = record as Record<string, unknown>;
  // Joins may carry the user nested in a session result.
  return 'user' in result ? { ...result, user: readUser(result.user) } : record;
}

function writeUser(record: Record<string, unknown>, creating: boolean): Record<string, unknown> {
  normalizedEmail(record.email);
  if (!('emailVerified' in record)) return record;
  if (typeof record.emailVerified !== 'boolean') throw new Error('AUTHORITY_INVALID_VERIFICATION_BOOLEAN');
  return {
    ...record,
    // An already verified user's original timestamp must never be refreshed by BA.
    emailVerified: record.emailVerified
      ? creating
        ? new Date()
        : sql`coalesce(${users.emailVerified}, CURRENT_TIMESTAMP)`
      : null,
  };
}

/** Caller owns the transaction. BA's transaction callback reuses this adapter; it cannot open another one. */
export function createAuthorityAdapter(database: AuthorityTransaction) {
  const factory = drizzleAdapter(database, { provider: 'pg', schema: authoritySchema, transaction: false });
  return (options: BetterAuthOptions): Adapter => {
    // Adapter metadata describes storage; BA's public schema remains boolean.
    // Without this, its required/default-false handling would replace NULL on insert.
    const delegate = factory({
      ...options,
      account: {
        ...options.account,
        additionalFields: {
          ...options.account?.additionalFields,
          sourceGeneration: { type: 'number', required: false, input: false },
        },
      },
      user: {
        ...options.user,
        additionalFields: {
          ...options.user?.additionalFields,
          emailVerified: { type: 'date', required: false, input: false },
        },
      },
    });
    const adapter: Adapter = {
      ...delegate,
      async create(parameters) {
        const result = await delegate.create({
          ...parameters,
          data: parameters.model === 'user' ? writeUser(parameters.data, true) : parameters.data,
        });
        return readResult(parameters.model, result) as never;
      },
      async findOne(parameters) {
        return readResult(
          parameters.model,
          await delegate.findOne({ ...parameters, where: storageWhere(parameters.model, parameters.where) }),
        ) as never;
      },
      async findMany(parameters) {
        return (
          await delegate.findMany({
            ...parameters,
            where: parameters.where && storageWhere(parameters.model, parameters.where),
          })
        ).map((record) => readResult(parameters.model, record)) as never;
      },
      async update(parameters) {
        return readResult(
          parameters.model,
          await delegate.update({
            ...parameters,
            where: storageWhere(parameters.model, parameters.where),
            update: parameters.model === 'user' ? writeUser(parameters.update, false) : parameters.update,
          }),
        ) as never;
      },
      async updateMany(parameters) {
        return delegate.updateMany({
          ...parameters,
          where: storageWhere(parameters.model, parameters.where),
          update: parameters.model === 'user' ? writeUser(parameters.update, false) : parameters.update,
        });
      },
      async consumeOne(parameters) {
        return readResult(
          parameters.model,
          await delegate.consumeOne({ ...parameters, where: storageWhere(parameters.model, parameters.where) }),
        ) as never;
      },
      async count(parameters) {
        return delegate.count({
          ...parameters,
          where: parameters.where && storageWhere(parameters.model, parameters.where),
        });
      },
      async delete(parameters) {
        return delegate.delete({ ...parameters, where: storageWhere(parameters.model, parameters.where) });
      },
      async deleteMany(parameters) {
        return delegate.deleteMany({ ...parameters, where: storageWhere(parameters.model, parameters.where) });
      },
      async incrementOne(parameters) {
        if (parameters.model === 'user') throw new Error('AUTHORITY_USER_INCREMENT_UNSUPPORTED');
        return delegate.incrementOne(parameters);
      },
      async transaction(callback) {
        return callback(adapter);
      },
    };
    return adapter;
  };
}
