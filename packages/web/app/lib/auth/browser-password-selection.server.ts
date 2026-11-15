import 'server-only';
import type { WebCredentialProof } from '@boardsesh/auth-protocol';
import {
  browserPasswordSourceSchema,
  type BrowserPasswordPreparation,
  type BrowserPasswordSource,
} from '@boardsesh/auth-protocol/browser-password-v1';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { browserPasswordCandidateHash } from './browser-password-command-client.server';
import type { BrowserPasswordCustody } from './browser-password-custody.server';
import { readBrowserCorrelationCookie } from './browser-proof-cookies.server';
import type { AdmittedBrowserSelection, PresentedBrowserSelection } from './presented-browser-selection.server';

const refuse = (): never => {
  throw new AuthBackendUnavailableError();
};
export interface BrowserPasswordSourceContext {
  readonly source: Readonly<BrowserPasswordSource>;
  readonly cursor: Readonly<{ bindingId: string; version: number; bindingExpiresAt: string }>;
  readonly session: AdmittedBrowserSelection['session'] | null;
}
export function passwordSessionProof(session: AdmittedBrowserSelection['session']): WebCredentialProof {
  return {
    version: 1,
    userId: session.userId,
    authSessionId: session.authSessionId,
    generation: session.generation,
    authenticatedAt: session.authenticatedAt,
    linkGuarded: session.linkGuarded,
    ...(session.requiresAccountCutoff ? { requiresAccountCutoff: true as const } : {}),
  };
}
function sameProof(left: WebCredentialProof, right: WebCredentialProof): boolean {
  return (
    left.userId === right.userId &&
    left.authSessionId === right.authSessionId &&
    left.generation === right.generation &&
    left.authenticatedAt === right.authenticatedAt &&
    left.linkGuarded === right.linkGuarded &&
    Boolean(left.requiresAccountCutoff) === Boolean(right.requiresAccountCutoff)
  );
}
function sameCursor(
  left: BrowserPasswordSourceContext['cursor'],
  right: BrowserPasswordSourceContext['cursor'],
): boolean {
  return (
    left.bindingId === right.bindingId &&
    left.version === right.version &&
    left.bindingExpiresAt === right.bindingExpiresAt
  );
}

/** Only an actual primary anonymous read may omit an actor. A missing selected
 * proof is never converted to this source-free branch. */
export function captureBrowserPasswordSource(
  header: string | null,
  selection: PresentedBrowserSelection,
): BrowserPasswordSourceContext {
  const correlation = readBrowserCorrelationCookie(header);
  if (
    (selection.status !== 'admitted' && selection.status !== 'anonymous') ||
    correlation.status !== 'present' ||
    correlation.bindingId !== selection.cursor.bindingId ||
    Date.parse(selection.cursor.bindingExpiresAt) <= Date.now()
  )
    return refuse();
  const source = browserPasswordSourceSchema.parse(
    selection.status === 'admitted'
      ? {
          state: 'selected',
          bindingToken: correlation.token,
          expectedVersion: selection.cursor.version,
          actor: { version: selection.actor.version, credential: { ...selection.actor.credential } },
        }
      : { state: 'anonymous', bindingToken: correlation.token, expectedVersion: selection.cursor.version },
  );
  if (
    selection.status === 'admitted' &&
    (selection.bindingToken !== correlation.token || Date.parse(selection.session.expiresAt) <= Date.now())
  )
    return refuse();
  return Object.freeze({
    source: Object.freeze(source),
    cursor: Object.freeze({ ...selection.cursor }),
    session: selection.status === 'admitted' ? Object.freeze({ ...selection.session }) : null,
  });
}
export function requireSameBrowserPasswordSource(
  expected: BrowserPasswordSourceContext,
  actual: BrowserPasswordSourceContext,
): void {
  if (
    !sameCursor(expected.cursor, actual.cursor) ||
    JSON.stringify(expected.source) !== JSON.stringify(actual.source) ||
    Boolean(expected.session) !== Boolean(actual.session) ||
    (expected.session &&
      actual.session &&
      (!sameProof(passwordSessionProof(expected.session), passwordSessionProof(actual.session)) ||
        expected.session.expiresAt !== actual.session.expiresAt))
  )
    return refuse();
}
export function requirePreparedPasswordSource(
  preparation: BrowserPasswordPreparation,
  source: BrowserPasswordSourceContext,
): void {
  if (!sameCursor(preparation.browserCursor, source.cursor) || preparation.source.state !== source.source.state)
    return refuse();
  if (preparation.source.state === 'selected') {
    if (
      source.source.state !== 'selected' ||
      !source.session ||
      preparation.source.credentialHash !== browserPasswordCandidateHash(source.source.actor.credential) ||
      !sameProof(preparation.source.credentialProof, passwordSessionProof(source.session)) ||
      preparation.source.expiresAt !== source.session.expiresAt
    )
      return refuse();
  } else if (source.session !== null) return refuse();
}
/** Actual delivered/projected candidate proof plus primary admission, never a
 * Session constructed from custody or a public metadata cursor. */
export function passwordTargetMatches(
  selection: PresentedBrowserSelection,
  custody: Readonly<BrowserPasswordCustody>,
): selection is AdmittedBrowserSelection {
  return (
    selection.status === 'admitted' &&
    sameCursor(selection.cursor, custody.preparation.futureBrowserCursor) &&
    selection.bindingToken === custody.source.bindingToken &&
    browserPasswordCandidateHash(selection.actor.credential) === browserPasswordCandidateHash(custody.candidate) &&
    sameProof(passwordSessionProof(selection.session), custody.preparation.credentialProof) &&
    selection.session.expiresAt === custody.preparation.credentialExpiresAt
  );
}
