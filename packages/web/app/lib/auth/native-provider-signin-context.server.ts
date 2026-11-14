import 'server-only';
import type { NativeProviderSigninContext } from '@boardsesh/auth-protocol/native-browser-handoff-v1';
import { NATIVE_OAUTH_ATTEMPT_COOKIE, nativeOAuthAttemptBinding } from './native-oauth-attempt.server';
import { boundedAuthCookiePairs } from './public-auth-request.server';
import { openAnonymousProviderFlow } from './anonymous-provider-flow.server';
import { readAnonymousProviderRecoveryInput } from './anonymous-provider-recovery.server';
import {
  readPresentedBrowserSelection,
  type AdmittedBrowserSelection,
  type PresentedBrowserSelection,
} from './presented-browser-selection.server';

/** Optional attribution proof only. Source identity still comes from the
 * independent native handoff issuer and fresh selection checks. */
export async function readNativeProviderSigninContext(
  cookieHeader: string | null,
  selection: AdmittedBrowserSelection,
  returnUrl: string,
  options: {
    readonly secret: string;
    readonly readSelection?: (cookies: string | null) => Promise<PresentedBrowserSelection>;
  },
): Promise<NativeProviderSigninContext | undefined> {
  const captured = structuredClone(selection);
  const readSelection = options.readSelection ?? readPresentedBrowserSelection;
  const observed = boundedAuthCookiePairs(cookieHeader);
  const markers = observed.filter((cookie) => cookie.name === NATIVE_OAUTH_ATTEMPT_COOKIE);
  if (markers.length !== 1) return undefined;
  const carriers = observed.filter((cookie) =>
    /^__Host-boardsesh\.(?:provider-signin|anonymous-provider)\./.test(cookie.name),
  );
  if (carriers.length > 4 || new Set(carriers.map((cookie) => cookie.name)).size !== carriers.length) return undefined;
  let context: NativeProviderSigninContext | undefined;
  for (const carrier of carriers) {
    const located = carrier.name.match(/^__Host-boardsesh\.anonymous-provider\.([a-f0-9]{64})$/);
    if (!located) continue;
    const flow = await openAnonymousProviderFlow(carrier.content, located[1], options.secret);
    if (
      !flow.preparation ||
      !flow.nativeAttemptHash ||
      flow.returnUrl !== returnUrl ||
      nativeOAuthAttemptBinding(markers[0].content, returnUrl, flow.provider, options.secret, Date.now()) !==
        flow.nativeAttemptHash
    )
      continue;
    if (context) return undefined;
    const recovery = await readAnonymousProviderRecoveryInput(cookieHeader, located[1], {
      secret: options.secret,
      readSelection,
    });
    const command = recovery.command;
    const proof = command.preparation.credentialProof;
    const actual = captured.actor.credential;
    if (
      recovery.browserCursor.bindingId !== captured.cursor.bindingId ||
      recovery.browserCursor.version !== captured.cursor.version ||
      recovery.browserCursor.bindingExpiresAt !== captured.cursor.bindingExpiresAt ||
      command.candidate.kind !== actual.kind ||
      command.candidate.credential !== (actual.kind === 'canonical-token' ? actual.token : actual.credential) ||
      proof.userId !== captured.session.userId ||
      proof.authSessionId !== captured.session.authSessionId ||
      proof.generation !== captured.session.generation ||
      proof.authenticatedAt !== captured.session.authenticatedAt ||
      proof.linkGuarded !== captured.session.linkGuarded ||
      Boolean(proof.requiresAccountCutoff) !== captured.session.requiresAccountCutoff ||
      command.preparation.credentialExpiresAt !== captured.session.expiresAt
    )
      return undefined;
    context = {
      receipt: {
        browser: command.browser,
        intentToken: command.intentToken,
        browserIntentToken: command.browserIntentToken,
        flowHash: command.flowHash,
        nonceHash: command.nonceHash,
        ...(command.nativeAttemptHash ? { nativeAttemptHash: command.nativeAttemptHash } : {}),
        preparationToken: command.preparationToken,
        preparation: command.preparation,
      },
      attempt: { token: markers[0].content, returnUrl },
    };
  }
  return context;
}
