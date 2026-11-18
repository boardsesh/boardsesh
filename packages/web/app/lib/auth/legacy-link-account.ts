import type { AccountEmailResolution } from '@boardsesh/auth-protocol/account-email';

/** How long a legacy password reset link lives. The issuer and the reader must agree. */
export const LEGACY_PASSWORD_RESET_LIFETIME_MS = 60 * 60 * 1000;
/** How long a legacy email verification link lives. The issuers and the reader must agree. */
export const LEGACY_EMAIL_VERIFICATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
/**
 * How far an account's creation may follow the link's issue time. Registration
 * stamps the link's expiry on the web server, then the database stamps the new
 * account's creation a moment later, on its own clock.
 */
export const LEGACY_LINK_CREATION_TOLERANCE_MS = 60_000;

/**
 * The account a legacy reset or verification link was issued for, or null.
 *
 * The link's token row stores only an email-derived identifier, not a user id
 * (`verification_tokens` has no such column). Every issuer, past and present,
 * writes the account's address exactly as stored, so the tightest binding
 * available without a migration is:
 *
 * - Exactly one account stores the link's address exactly. Never another
 *   capitalisation: that is a different row, and if it is the only one, the row
 *   the link was issued for is gone.
 * - That account existed when the link was issued, so a row deleted and then
 *   recreated at the same address while the link is live does not inherit it.
 *
 * The email resolution tool will not change an address while a link for it is
 * live, so the one account found here is the one the link was issued for.
 */
export function legacyLinkAccount<Account extends { readonly createdAt: Date }>(
  resolution: AccountEmailResolution<Account>,
  link: { readonly expires: Date; readonly lifetimeMs: number },
): Account | null {
  if (resolution.kind !== 'exact' || resolution.rows.length !== 1) return null;
  const [account] = resolution.rows;
  const issuedAt = link.expires.getTime() - link.lifetimeMs;
  return account.createdAt.getTime() <= issuedAt + LEGACY_LINK_CREATION_TOLERANCE_MS ? account : null;
}
