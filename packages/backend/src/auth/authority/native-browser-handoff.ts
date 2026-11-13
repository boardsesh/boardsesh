import { createHash } from 'node:crypto';
import { verificationTokens } from '@boardsesh/db/schema/auth';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
import type { BrowserSelectionCredential } from './browser-binding';
import type { IdentityAuthorityQualification } from './router';
import type { FirstPartySession } from './session-reader';
import {
  issueBrowserSourceCapability,
  useBrowserSourceCapability,
  type BrowserSourceCapabilityDatabase,
} from './browser-source-capability';

export const NATIVE_BROWSER_HANDOFF_PREFIX = 'bsnh1_';
export const NATIVE_BROWSER_HANDOFF_KEY_ENV = 'NATIVE_BROWSER_HANDOFF_SECRET';
export const NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX = 'ba03-native-handoff-v1:';
type Environment = Readonly<Record<string, string | undefined>>;

/** Source possession is re-admitted on primary; public session metadata and
 * backend delegation tokens cannot mint a native transfer capability. */
export function issueNativeBrowserHandoff(
  database: AuthorityDatabase,
  qualification: IdentityAuthorityQualification,
  requested: { readonly bindingToken: string; readonly actor: BrowserSelectionCredential },
  environment: Environment = process.env,
) {
  return issueBrowserSourceCapability(database, qualification, 'native-handoff', requested, environment);
}

/** The one-shot receipt and native credentials share the admission transaction.
 * A failed issuer, lost final deadline or uncertain commit never reports a
 * successful exchange. Dedicated DB-clock cleanup retains the hash until the
 * signed capability has expired; no source bytes are stored here. */
export async function redeemNativeBrowserHandoff<Result>(
  database: BrowserSourceCapabilityDatabase,
  qualification: IdentityAuthorityQualification,
  token: string,
  issue: (transaction: AuthorityTransaction, session: FirstPartySession, expiresAt: Date) => Promise<Result>,
  environment: Environment = process.env,
): Promise<
  { readonly status: 'admitted'; readonly result: Result } | { readonly status: 'denied' | 'conflict' | 'unavailable' }
> {
  const digest = createHash('sha256').update(token).digest('hex');
  const result = await useBrowserSourceCapability(
    database,
    qualification,
    'native-handoff',
    token,
    async (transaction, session, expiresAt) => {
      const claimed = await transaction
        .insert(verificationTokens)
        .values({ identifier: `${NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX}${digest}`, token: digest, expires: expiresAt })
        .onConflictDoNothing()
        .returning({ token: verificationTokens.token });
      if (claimed.length !== 1) return { status: 'conflict' as const };
      return { status: 'admitted' as const, result: await issue(transaction, session, expiresAt) };
    },
    environment,
  );
  if (result.status !== 'admitted') return result;
  return result.result;
}
