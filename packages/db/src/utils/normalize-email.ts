/**
 * Canonicalises an email for storage, lookup, and identifier derivation.
 *
 * Trims surrounding whitespace and lower-cases the address so that
 * `Foo@x.com` and `foo@x.com` resolve to the same account. This is the single
 * source of truth for email canonicalisation — every auth write path (web +
 * backend native-auth) and the account-merge/backfill route through it so the
 * stored value, the case-insensitive `lower(email)` unique index, and any
 * email-derived token identifier (verification tokens, `password-reset:<email>`)
 * always agree.
 *
 * Throws on a non-string input rather than silently coercing: callers validate
 * the email before reaching a write path, and a wrong-typed value matching the
 * empty string could collide accounts.
 */
export function normalizeEmail(email: string): string {
  if (typeof email !== 'string') {
    throw new TypeError(`normalizeEmail expected a string, received ${typeof email}`);
  }
  return email.trim().toLowerCase();
}
