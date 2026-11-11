/**
 * Unmounted consolidation bridge policy. Inputs must come from verified server
 * credentials and transaction-locked database state, never a request body.
 * This exception is valid only at credential exchange, not ordinary admission.
 */
export interface ConsolidationRetirement {
  readonly mergeId: string;
  readonly sourceUserId: string;
  readonly targetUserId: string;
  readonly retiredAtMs: number;
  readonly sourceGenerationBefore: number;
  readonly sourceNativeGenerationBefore: number;
  readonly sourceGenerationAfter: number;
  readonly sourceNativeGenerationAfter: number;
  readonly targetGeneration: number;
  readonly targetNativeGeneration: number;
}

export interface ConsolidationSubjectState {
  readonly userId: string;
  readonly active: boolean;
  readonly generation: number;
  readonly nativeGeneration: number;
  /** Non-null only for an account retired by this exact consolidation. */
  readonly consolidationMergeId: string | null;
}

interface VerifiedProofBase {
  readonly userId: string;
  readonly credentialId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly authenticatedAtMs: number | null;
  readonly sourceGeneration: number;
  readonly revoked: boolean;
}

export type VerifiedConsolidationProof =
  | (VerifiedProofBase & {
      readonly kind: 'native-refresh';
      readonly sourceNativeGeneration: number;
      readonly sessionId: string | null;
    })
  | (VerifiedProofBase & {
      readonly kind: 'web-session';
      readonly sessionId: string;
      /** A stable SID plus full original revocation admission, not signature alone. */
      readonly revocationLineageVerified: boolean;
    });

export interface ConsolidationTransferState {
  readonly retirement: ConsolidationRetirement;
  readonly source: ConsolidationSubjectState;
  readonly target: ConsolidationSubjectState;
  /** Explicit per-proof/lineage invalidation, including sign-outs without generation changes. */
  readonly bridgeRevoked: boolean;
}

export type ConsolidationTransferDenial =
  | 'invalid-state'
  | 'wrong-owner'
  | 'not-consolidated'
  | 'expired'
  | 'revoked'
  | 'generation'
  | 'unknown-web-lineage';

export type ConsolidationTransferDecision =
  | { readonly allowed: false; readonly reason: ConsolidationTransferDenial }
  | {
      readonly allowed: true;
      readonly mergeId: string;
      readonly fromUserId: string;
      readonly toUserId: string;
      readonly credentialId: string;
      readonly kind: VerifiedConsolidationProof['kind'];
      readonly authenticatedAtMs: number | null;
      readonly originalExpiresAtMs: number;
      readonly originalSessionId: string | null;
      readonly targetGeneration: number;
      readonly targetNativeGeneration: number;
    };

function generation(stamp: number): boolean {
  return Number.isSafeInteger(stamp) && stamp >= 0;
}
function timestamp(instant: number): boolean {
  return Number.isSafeInteger(instant) && instant >= 0;
}
function identifier(candidate: string): boolean {
  return (
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    candidate.length <= 4096 &&
    candidate === candidate.trim() &&
    !/\p{Cc}/u.test(candidate)
  );
}

export function decideConsolidationSessionTransfer(
  proof: VerifiedConsolidationProof,
  state: ConsolidationTransferState,
  nowMs: number,
): ConsolidationTransferDecision {
  const { retirement, source, target } = state;
  if (proof.kind !== 'native-refresh' && proof.kind !== 'web-session')
    return { allowed: false, reason: 'invalid-state' };
  const deny = (reason: ConsolidationTransferDenial): ConsolidationTransferDecision => ({ allowed: false, reason });
  if (
    ![
      retirement.mergeId,
      retirement.sourceUserId,
      retirement.targetUserId,
      source.userId,
      target.userId,
      proof.userId,
      proof.credentialId,
    ].every(identifier) ||
    ![
      retirement.sourceGenerationBefore,
      retirement.sourceNativeGenerationBefore,
      retirement.sourceGenerationAfter,
      retirement.sourceNativeGenerationAfter,
      retirement.targetGeneration,
      retirement.targetNativeGeneration,
      source.generation,
      source.nativeGeneration,
      target.generation,
      target.nativeGeneration,
      proof.sourceGeneration,
    ].every(generation) ||
    ![nowMs, retirement.retiredAtMs, proof.issuedAtMs, proof.expiresAtMs].every(timestamp) ||
    retirement.sourceGenerationAfter !== retirement.sourceGenerationBefore + 1 ||
    retirement.sourceNativeGenerationAfter < retirement.sourceNativeGenerationBefore ||
    proof.issuedAtMs > retirement.retiredAtMs ||
    retirement.retiredAtMs > nowMs ||
    proof.expiresAtMs <= proof.issuedAtMs ||
    (proof.authenticatedAtMs !== null &&
      (!timestamp(proof.authenticatedAtMs) || proof.authenticatedAtMs > proof.issuedAtMs))
  )
    return deny('invalid-state');
  if (
    retirement.sourceUserId === retirement.targetUserId ||
    proof.userId !== retirement.sourceUserId ||
    source.userId !== retirement.sourceUserId ||
    target.userId !== retirement.targetUserId
  )
    return deny('wrong-owner');
  if (
    source.active ||
    !target.active ||
    source.consolidationMergeId !== retirement.mergeId ||
    target.consolidationMergeId !== null
  )
    return deny('not-consolidated');
  if (proof.expiresAtMs <= nowMs) return deny('expired');
  if (proof.revoked || state.bridgeRevoked) return deny('revoked');
  if (
    proof.sourceGeneration !== retirement.sourceGenerationBefore ||
    source.generation !== retirement.sourceGenerationAfter ||
    source.nativeGeneration !== retirement.sourceNativeGenerationAfter ||
    target.generation !== retirement.targetGeneration ||
    (proof.kind === 'native-refresh' &&
      (!generation(proof.sourceNativeGeneration) ||
        proof.sourceNativeGeneration !== retirement.sourceNativeGenerationBefore ||
        target.nativeGeneration !== retirement.targetNativeGeneration))
  )
    return deny('generation');
  if (proof.kind === 'web-session' && (!identifier(proof.sessionId) || proof.revocationLineageVerified !== true))
    return deny('unknown-web-lineage');
  if (proof.kind === 'native-refresh' && proof.sessionId !== null && !identifier(proof.sessionId))
    return deny('invalid-state');
  return {
    allowed: true,
    mergeId: retirement.mergeId,
    fromUserId: retirement.sourceUserId,
    toUserId: retirement.targetUserId,
    credentialId: proof.credentialId,
    kind: proof.kind,
    authenticatedAtMs: proof.authenticatedAtMs,
    originalExpiresAtMs: proof.expiresAtMs,
    originalSessionId: proof.sessionId,
    targetGeneration: target.generation,
    targetNativeGeneration: target.nativeGeneration,
  };
}
