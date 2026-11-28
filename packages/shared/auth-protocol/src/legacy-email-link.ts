import type { AccountEmailResolution } from './account-email';

export const LEGACY_PASSWORD_RESET_LIFETIME_MS = 60 * 60 * 1000;
export const LEGACY_EMAIL_VERIFICATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const LEGACY_LINK_CREATION_TOLERANCE_MS = 60_000;

/**
 * Released legacy compatibility only. This inferred issuance time is not
 * immutable original-owner evidence and cannot authorize canonical import.
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
