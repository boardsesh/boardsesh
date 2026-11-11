import { vi } from 'vitest';
import { ACCOUNT_EMAIL_CANDIDATE_LIMIT, resolveAccountEmail } from '@boardsesh/auth-protocol/account-email';
import type { AccountEmailRow } from '@boardsesh/db/queries/account-email';

export type StoredAccount = Pick<AccountEmailRow, 'id' | 'email'> & Partial<AccountEmailRow>;

/**
 * Test double for `@boardsesh/db/queries/account-email`. It filters `stored()`
 * the way the real query's SQL does (`lower(email)` equal to the normalized or
 * the lowercased typed text, ordered by id, limit + 1), then runs the real
 * shared resolver. The SQL itself is checked against Postgres in the backend's
 * account-email-lookup suite.
 */
export function fakeAccountEmailLookup(stored: () => readonly StoredAccount[]) {
  const findAccountsByEmail = vi.fn(async (_database: unknown, typedEmail: string) => {
    const keys = new Set([typedEmail.trim().toLowerCase(), typedEmail.toLowerCase()]);
    const rows: AccountEmailRow[] = stored()
      .filter((account) => keys.has(account.email.toLowerCase()))
      .map((account) => ({
        name: null,
        image: null,
        emailVerified: null,
        passwordHash: null,
        ...account,
      }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .slice(0, ACCOUNT_EMAIL_CANDIDATE_LIMIT + 1);
    return resolveAccountEmail(typedEmail, rows);
  });
  return { findAccountsByEmail };
}
