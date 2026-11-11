import {
  decideConsolidationSessionTransfer,
  type ConsolidationTransferState,
  type VerifiedConsolidationProof,
  type ConsolidationTransferDecision,
} from './decision';

export class ConsolidationExchangeError extends Error {
  constructor(readonly code: 'INELIGIBLE' | 'CONSUMED' | 'DRIFT') {
    super('Consolidation session exchange refused.');
    this.name = 'ConsolidationExchangeError';
  }
}

type AllowedTransfer = Extract<ConsolidationTransferDecision, { allowed: true }>;

/**
 * The adapter MUST be bound to one outer database transaction. Its consume and
 * issuance either both commit or both roll back. Do not acknowledge a result
 * until that transaction commits. A lost response follows normal single-use
 * refresh recovery; this helper never creates a second family on replay.
 */
export interface ConsolidationExchangeTransaction<Result> {
  lockSubjectsInOrder(userIds: readonly string[]): Promise<void>;
  /** Lock the exact proof and retirement rows, then reload both subject states. */
  readLockedTransfer(credentialId: string): Promise<{
    proof: VerifiedConsolidationProof;
    state: ConsolidationTransferState;
  } | null>;
  consumeOnce(credentialId: string, mergeId: string): Promise<boolean>;
  /** Recheck target revocation while creating the mapped lineage, in this same transaction. */
  issueCanonical(decision: AllowedTransfer): Promise<Result>;
}

export async function exchangeConsolidationSession<Result>(
  transaction: ConsolidationExchangeTransaction<Result>,
  hint: { readonly credentialId: string; readonly sourceUserId: string; readonly targetUserId: string },
  now: () => number = Date.now,
): Promise<Result> {
  const { credentialId, sourceUserId, targetUserId } = hint;
  if (!credentialId || !sourceUserId || !targetUserId || sourceUserId === targetUserId)
    throw new ConsolidationExchangeError('INELIGIBLE');
  await transaction.lockSubjectsInOrder([sourceUserId, targetUserId].sort());
  const locked = await transaction.readLockedTransfer(credentialId);
  if (
    !locked ||
    locked.proof.credentialId !== credentialId ||
    locked.state.retirement.sourceUserId !== sourceUserId ||
    locked.state.retirement.targetUserId !== targetUserId
  )
    throw new ConsolidationExchangeError('DRIFT');
  const decision = decideConsolidationSessionTransfer(locked.proof, locked.state, now());
  if (!decision.allowed) throw new ConsolidationExchangeError('INELIGIBLE');
  if (!(await transaction.consumeOnce(credentialId, decision.mergeId)))
    throw new ConsolidationExchangeError('CONSUMED');
  return transaction.issueCanonical(decision);
}
