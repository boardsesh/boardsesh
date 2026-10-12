import { getPrivacyRevocationGeneration } from './privacy-cache';

// Scopes and completed proofs belong to this module's runtime. Hydrating a
// previous generation-zero cache must never authorize it in a new runtime.
const capturedGenerations = new WeakMap<object, number>();

export type PrivacyReadAuthorization = { readonly isCurrent: () => boolean };

class CompletedPrivacyRead {
  constructor(readonly generation: number) {
    Object.freeze(this);
  }
}

export function capturePrivacyReadScope(): object {
  const scope = {};
  capturedGenerations.set(scope, getPrivacyRevocationGeneration());
  return scope;
}

/** Only a successful response from the still-current captured scope earns a proof. */
export function completePrivacyRead(scope: object): CompletedPrivacyRead | null {
  const generation = capturedGenerations.get(scope);
  return generation === getPrivacyRevocationGeneration() ? new CompletedPrivacyRead(generation) : null;
}

/** Mixed, unfinished or hydrated pages cannot authorize a retained list. */
export function completedPrivacyReadGeneration(proofs: readonly unknown[]): number | null {
  if (proofs.length === 0) return null;
  const generation = getPrivacyRevocationGeneration();
  return proofs.every((proof) => proof instanceof CompletedPrivacyRead && proof.generation === generation)
    ? generation
    : null;
}
