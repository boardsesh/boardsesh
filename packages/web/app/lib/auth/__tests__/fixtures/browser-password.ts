import { createHash } from 'node:crypto';
import type { BrowserPasswordPreparation, BrowserPasswordSource } from '@boardsesh/auth-protocol/browser-password-v1';
import type { BrowserSourceCredential } from '@boardsesh/auth-protocol/browser-binding-v1';

export const passwordTestEnvironment = {
  CURRENT_STORE_BROWSER_PASSWORD_MODE: 'backend-staging',
  CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'https://private.password.example.test',
  CURRENT_STORE_AUTH_RPC_SECRET: 'owned-password-www-private-rpc-secret-6975',
  NEXTAUTH_SECRET: 'owned-password-www-different-cookie-secret-6975',
  NEXTAUTH_URL: 'https://www.boardsesh.test',
};
export const passwordTestHash = (text: string) => createHash('sha256').update(text).digest('hex');
export function passwordTestCredentialHash(credential: BrowserSourceCredential) {
  return passwordTestHash(
    JSON.stringify([
      'browser-selection-credential-v2',
      credential.kind,
      credential.kind === 'canonical-token' ? credential.token : credential.credential,
    ]),
  );
}
export function browserPasswordFixture(
  kind: 'legacy-jwe' | 'canonical-token' = 'canonical-token',
  selected = true,
  milliseconds = Date.now(),
) {
  const bindingToken = Buffer.alloc(32, 11).toString('base64url');
  const operationToken = Buffer.alloc(32, 12).toString('base64url');
  const browserIntentToken = Buffer.alloc(32, 13).toString('base64url');
  const proposedCanonicalToken = Buffer.alloc(32, 14).toString('base64url');
  const original: BrowserSourceCredential =
    kind === 'canonical-token'
      ? { kind, token: Buffer.alloc(32, 15).toString('base64url') }
      : { kind, credential: 'original.actual-jwe-bytes' };
  const candidate: BrowserSourceCredential =
    kind === 'canonical-token'
      ? { kind, token: proposedCanonicalToken }
      : { kind, credential: 'installed.candidate-jwe-bytes' };
  const source: BrowserPasswordSource = selected
    ? { state: 'selected', bindingToken, expectedVersion: 7, actor: { version: 7, credential: original } }
    : { state: 'anonymous', bindingToken, expectedVersion: 7 };
  const cursor = {
    bindingId: passwordTestHash(bindingToken),
    version: 7,
    bindingExpiresAt: new Date(milliseconds + 86_400_000).toISOString(),
  };
  const authenticatedAt = new Date(Math.floor((milliseconds - 5) / 1_000) * 1_000).toISOString();
  const preparation: BrowserPasswordPreparation = {
    version: 1,
    purpose: 'browser-password-publication-v1',
    source: selected
      ? {
          state: 'selected',
          credentialKind: kind,
          credentialHash: passwordTestCredentialHash(original),
          credentialProof: {
            version: 1,
            userId: 'original-A',
            authSessionId: 'original-A-SID',
            generation: 1,
            authenticatedAt: null,
            linkGuarded: false,
          },
          expiresAt: new Date(milliseconds + 3_600_000).toISOString(),
        }
      : { state: 'anonymous' },
    browserCursor: cursor,
    sourceIntentRevision: 4,
    intentRevision: 5,
    preparedStateHash: 'a'.repeat(64),
    futureBrowserCursor: { ...cursor, version: 8 },
    authority: {
      projectionId: 'owned-projection',
      normalizerVersion: 'owned-normalizer',
      authority: 'current-store',
      epoch: 1,
    },
    nonceHash: 'e'.repeat(64),
    passwordStateHash: 'f'.repeat(64),
    credentialKind: kind,
    passwordVerifiedAt: new Date(milliseconds - 5).toISOString(),
    credentialProof: {
      version: 1,
      userId: 'matched-B',
      authSessionId: 'fresh-B-SID',
      generation: 2,
      authenticatedAt,
      linkGuarded: true,
    },
    credentialExpiresAt: new Date(Date.parse(authenticatedAt) + 30 * 86_400_000).toISOString(),
    proposedCanonicalTokenHash: kind === 'canonical-token' ? passwordTestCredentialHash(candidate) : null,
    verification: { required: true, verified: true },
    preparedAt: new Date(milliseconds).toISOString(),
    expiresAt: new Date(milliseconds + 60_000).toISOString(),
    acknowledgeUntil: new Date(milliseconds + 300_000).toISOString(),
  };
  return {
    source,
    candidate,
    preparation,
    operationToken,
    browserIntentToken,
    proposedCanonicalToken: kind === 'canonical-token' ? proposedCanonicalToken : null,
    user: { id: 'matched-B', email: 'matched@example.test', name: 'Matched', image: null },
  };
}

export function passwordTestSelection(
  current: ReturnType<typeof browserPasswordFixture>,
  target = false,
): import('../../presented-browser-selection.server').PresentedBrowserSelection {
  if (!target && current.source.state === 'anonymous')
    return { status: 'anonymous', cursor: current.preparation.browserCursor };
  const snapshot = target
    ? { proof: current.preparation.credentialProof, expiresAt: current.preparation.credentialExpiresAt }
    : current.preparation.source.state === 'selected'
      ? { proof: current.preparation.source.credentialProof, expiresAt: current.preparation.source.expiresAt }
      : null;
  if (!snapshot || (!target && current.source.state !== 'selected')) throw new Error('Expected selected fixture');
  return {
    status: 'admitted',
    bindingToken: current.source.bindingToken,
    actor: target
      ? { version: current.preparation.futureBrowserCursor.version, credential: current.candidate }
      : current.source.state === 'selected'
        ? current.source.actor
        : { version: 0, credential: current.candidate },
    cursor: target ? current.preparation.futureBrowserCursor : current.preparation.browserCursor,
    session: {
      userId: snapshot.proof.userId,
      authSessionId: snapshot.proof.authSessionId,
      generation: snapshot.proof.generation,
      authenticatedAt: snapshot.proof.authenticatedAt,
      linkGuarded: snapshot.proof.linkGuarded,
      requiresAccountCutoff: Boolean('requiresAccountCutoff' in snapshot.proof && snapshot.proof.requiresAccountCutoff),
      expiresAt: snapshot.expiresAt,
    },
    user: { id: snapshot.proof.userId, email: 'fixture@example.test', name: null, image: null },
  };
}
