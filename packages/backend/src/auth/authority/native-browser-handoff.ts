import { createHash } from 'node:crypto';
import { verificationTokens } from '@boardsesh/db/schema/auth';
import type { AuthorityDatabase, AuthorityTransaction } from './adapter';
import type { BrowserSelectionCredential } from './browser-binding';
import type { IdentityAuthorityQualification } from './router';
import type { FirstPartySession } from './session-reader';
import {
  nativeProviderSigninContextSchema,
  type NativeProviderSigninContext,
} from '@boardsesh/auth-protocol/native-browser-handoff-v1';
import {
  readNativeOAuthAttempt,
  nativeOAuthAttemptBinding,
  NATIVE_OAUTH_ATTEMPT_LIFETIME_MS,
} from './native-oauth-attempt';
import { providerSecurityConfiguration } from './provider-security-configuration';
import { readAnonymousProviderCreationReceipt } from './anonymous-provider-signin';
import {
  issueBrowserSourceCapability,
  useBrowserSourceCapability,
  type BrowserSourceCapabilityDatabase,
  type NativeBrowserCreationContext,
  type NativeBrowserCreationMetadata,
} from './browser-source-capability';

export const NATIVE_BROWSER_HANDOFF_PREFIX = 'bsnh1_';
export const NATIVE_BROWSER_HANDOFF_KEY_ENV = 'NATIVE_BROWSER_HANDOFF_SECRET';
export const NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX = 'ba03-native-handoff-v1:';
type Environment = Readonly<Record<string, string | undefined>>;

/** Source possession is re-admitted on primary; public session metadata and
 * backend delegation tokens cannot mint a native transfer capability. */
export async function issueNativeBrowserHandoff(
  database: AuthorityDatabase,
  qualification: IdentityAuthorityQualification,
  requested: {
    readonly bindingToken: string;
    readonly actor: BrowserSelectionCredential;
    readonly providerSignin?: NativeProviderSigninContext;
  },
  environment: Environment = process.env,
) {
  qualification = Object.freeze({ ...qualification });
  const captured = structuredClone(requested);
  const capturedEnvironment = Object.freeze({ ...environment });
  let creation: NativeBrowserCreationContext | undefined;
  if (captured.providerSignin) {
    const input = nativeProviderSigninContextSchema.parse(captured.providerSignin);
    if (
      input.receipt.browser.bindingToken !== captured.bindingToken ||
      input.receipt.browser.expectedVersion + 1 !== captured.actor.version
    )
      return { status: 'conflict' as const };
    const configuration = providerSecurityConfiguration(capturedEnvironment);
    if (configuration.mode !== 'backend-staging') return { status: 'unavailable' as const };
    if (
      configuration.runtime.qualification.expectedProjectionId !== qualification.expectedProjectionId ||
      configuration.runtime.qualification.expectedNormalizerVersion !== qualification.expectedNormalizerVersion
    )
      return { status: 'unavailable' as const };
    const source = captured.actor.credential;
    const receipt = await readAnonymousProviderCreationReceipt(database, configuration.runtime, {
      ...input.receipt,
      candidate: {
        kind: source.kind,
        credential: source.kind === 'canonical-token' ? source.token : source.credential,
      },
    });
    const now = Date.parse(receipt.observedAt);
    const marker = readNativeOAuthAttempt(input.attempt.token, capturedEnvironment.NEXTAUTH_SECRET ?? '', now);
    const digest = nativeOAuthAttemptBinding(
      input.attempt.token,
      input.attempt.returnUrl,
      receipt.accountCreation.provider,
      capturedEnvironment.NEXTAUTH_SECRET ?? '',
      now,
    );
    creation = {
      proof: input.receipt.preparation.credentialProof,
      cursor: { ...receipt.browserCursor, bindingExpiresAt: receipt.browserCursor.bindingExpiresAt.toISOString() },
      credentialExpiresAt: input.receipt.preparation.credentialExpiresAt,
      receiptExpiresAt: Date.parse(input.receipt.preparation.expiresAt),
      authority: receipt.authority,
      ...(marker && digest && digest === receipt.nativeAttemptHash && Date.parse(receipt.completedAt) > marker.startedAt
        ? {
            metadata: {
              ...receipt.accountCreation,
              attemptId: marker.attemptId,
              completedAt: Date.parse(receipt.completedAt),
            },
            markerExpiresAt: marker.startedAt + NATIVE_OAUTH_ATTEMPT_LIFETIME_MS,
          }
        : {}),
    };
  }
  return issueBrowserSourceCapability(
    database,
    qualification,
    'native-handoff',
    captured,
    capturedEnvironment,
    creation,
  );
}

/** The one-shot receipt and native credentials share the admission transaction.
 * A failed issuer, lost final deadline or uncertain commit never reports a
 * successful exchange. Dedicated DB-clock cleanup retains the hash until the
 * signed capability has expired; no source bytes are stored here. */
export async function redeemNativeBrowserHandoff<Result>(
  database: BrowserSourceCapabilityDatabase,
  qualification: IdentityAuthorityQualification,
  token: string,
  issue: (
    transaction: AuthorityTransaction,
    session: FirstPartySession,
    expiresAt: Date,
    creation?: NativeBrowserCreationMetadata,
  ) => Promise<Result>,
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
    async (transaction, session, expiresAt, creation) => {
      const claimed = await transaction
        .insert(verificationTokens)
        .values({ identifier: `${NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX}${digest}`, token: digest, expires: expiresAt })
        .onConflictDoNothing()
        .returning({ token: verificationTokens.token });
      if (claimed.length !== 1) return { status: 'conflict' as const };
      return { status: 'admitted' as const, result: await issue(transaction, session, expiresAt, creation) };
    },
    environment,
  );
  if (result.status !== 'admitted') return result;
  return result.result;
}
