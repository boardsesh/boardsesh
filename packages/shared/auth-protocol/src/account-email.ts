/**
 * The one account email rule, shared by web and backend: trim, then lowercase.
 * Dots, plus suffixes and the rest of the mailbox are kept as typed.
 */
export function normalizeAccountEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The most rows one address lookup reads. An address held by more rows than
 * this is refused as ambiguous. The largest shared group in production had 7
 * accounts on 2026-11-11.
 */
export const ACCOUNT_EMAIL_CANDIDATE_LIMIT = 8;

/**
 * What one typed address finds among stored accounts.
 *
 * - `exact`: one or more rows store the typed text as it is. They win, so a
 *   climber who types their address as stored reaches the same row as before.
 * - `normalized`: no row stores the typed text, and exactly one row stores it
 *   in another capitalisation.
 * - `ambiguous`: no row stores the typed text, and several rows share its
 *   normalized form (or more than ACCOUNT_EMAIL_CANDIDATE_LIMIT rows matched).
 *   Nothing is picked.
 * - `none`: no row has this address in any capitalisation.
 */
export type AccountEmailResolution<Row> =
  | { readonly kind: 'exact'; readonly rows: readonly Row[] }
  | { readonly kind: 'normalized'; readonly rows: readonly [Row] }
  | { readonly kind: 'ambiguous'; readonly rows: readonly [] }
  | { readonly kind: 'none'; readonly rows: readonly [] };

/**
 * Applies the lookup rule to the rows a query found for `typedEmail`: exact
 * match first, then the normalized form only when exactly one row has it.
 *
 * `rows` must be every row whose `lower(email)` equals the normalized typed
 * address or `lower()` of the typed text, read with a limit of
 * ACCOUNT_EMAIL_CANDIDATE_LIMIT + 1. A row the query found that this rule does
 * not recognise as the same address (SQL and JavaScript lowercasing can
 * disagree outside ASCII) makes the answer `ambiguous`, never a match.
 */
export function resolveAccountEmail<Row extends { readonly email: string }>(
  typedEmail: string,
  rows: readonly Row[],
): AccountEmailResolution<Row> {
  if (rows.length > ACCOUNT_EMAIL_CANDIDATE_LIMIT) return { kind: 'ambiguous', rows: [] };
  const exact = rows.filter((row) => row.email === typedEmail);
  if (exact.length > 0) return { kind: 'exact', rows: exact };
  if (rows.length === 0) return { kind: 'none', rows: [] };
  const [only] = rows;
  if (rows.length === 1 && normalizeAccountEmail(only.email) === normalizeAccountEmail(typedEmail))
    return { kind: 'normalized', rows: [only] };
  return { kind: 'ambiguous', rows: [] };
}

/**
 * The single account an address names, for flows with no password to tell
 * accounts apart (recovery, verification, provider linking). Several rows
 * storing the same exact text are as ambiguous as several capitalisations.
 */
export function soleAccount<Row>(resolution: AccountEmailResolution<Row>): Row | null {
  if (resolution.kind === 'normalized') return resolution.rows[0];
  if (resolution.kind === 'exact' && resolution.rows.length === 1) return resolution.rows[0];
  return null;
}
