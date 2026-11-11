import { eq, sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  ACCOUNT_EMAIL_CANDIDATE_LIMIT,
  normalizeAccountEmail,
  resolveAccountEmail,
  type AccountEmailResolution,
} from '@boardsesh/auth-protocol/account-email';
import { userCredentials } from '../schema/auth/credentials';
import { users } from '../schema/auth/users';

type AccountEmailReader = Pick<PgDatabase<PgQueryResultHKT, Record<string, unknown>>, 'select'>;

/**
 * Every row the account email rule could match for a typed address: its
 * normalized form, and `lower()` of the text as typed so a row stored exactly
 * as typed is found even if that text has surrounding spaces. Both arms are on
 * `lower(email)`, the expression the planned unique index covers.
 *
 * Read with `limit(ACCOUNT_EMAIL_CANDIDATE_LIMIT + 1)` and pass the rows to
 * `resolveAccountEmail`, which applies exact-first.
 */
export function accountEmailCandidates(typedEmail: string): SQL {
  return sql`lower(${users.email}) in (${normalizeAccountEmail(typedEmail)}::text, lower(${typedEmail}::text))`;
}

export interface AccountEmailRow {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly image: string | null;
  readonly emailVerified: Date | null;
  /** Null for an account with no password (provider sign-in only). */
  readonly passwordHash: string | null;
}

/**
 * The legacy web auth lookup: one query, whatever the address, so an unknown
 * address costs the database what a known one does. Exact match first, then
 * another capitalisation only when exactly one row has it.
 */
export async function findAccountsByEmail(
  database: AccountEmailReader,
  typedEmail: string,
): Promise<AccountEmailResolution<AccountEmailRow>> {
  const rows = await database
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      image: users.image,
      emailVerified: users.emailVerified,
      passwordHash: userCredentials.passwordHash,
    })
    .from(users)
    .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
    .where(accountEmailCandidates(typedEmail))
    .orderBy(users.id)
    .limit(ACCOUNT_EMAIL_CANDIDATE_LIMIT + 1);
  return resolveAccountEmail(typedEmail, rows);
}
