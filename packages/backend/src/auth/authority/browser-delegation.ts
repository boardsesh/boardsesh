import type { AuthorityDatabase } from './adapter';
import type { IdentityAuthorityQualification } from './router';
import type { BrowserSelectionCredential } from './browser-binding';
import type { FirstPartySession } from './session-reader';
import { issueBrowserSourceCapability, useBrowserSourceCapability } from './browser-source-capability';

/** A separate bearer family, never a source proof or native handoff. */
export const BROWSER_DELEGATION_PREFIX = 'bsbd1_';
export const BROWSER_DELEGATION_KEY_ENV = 'BROWSER_DELEGATION_SECRET';
export const BROWSER_DELEGATION_LIFETIME_MS = 120_000;
type Environment = Readonly<Record<string, string | undefined>>;
export type BrowserDelegationAdmission =
  | { readonly status: 'admitted'; readonly session: FirstPartySession; readonly expiresAt: Date }
  | { readonly status: 'denied' | 'conflict' | 'unavailable' };

export function issueBrowserDelegation(
  database: AuthorityDatabase,
  qualification: IdentityAuthorityQualification,
  requested: { readonly bindingToken: string; readonly actor: BrowserSelectionCredential },
  environment: Environment = process.env,
) {
  return issueBrowserSourceCapability(database, qualification, 'backend-delegation', requested, environment);
}

export async function admitBrowserDelegation(
  database: AuthorityDatabase,
  qualification: IdentityAuthorityQualification,
  token: string,
  environment: Environment = process.env,
): Promise<BrowserDelegationAdmission> {
  const admitted = await useBrowserSourceCapability(
    database,
    qualification,
    'backend-delegation',
    token,
    async () => undefined,
    environment,
  );
  if (admitted.status !== 'admitted') return admitted;
  return { status: 'admitted', session: admitted.session, expiresAt: admitted.expiresAt };
}
