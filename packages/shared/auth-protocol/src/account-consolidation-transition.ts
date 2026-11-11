import type { AccountConsolidationReceipt } from './account-consolidation';

export interface ConsolidationTransitionJournal extends AccountConsolidationReceipt {
  readonly phase: 'prepared' | 'credentials-published';
}

/** Platform writes recheck the epoch inside their serialized/transactional boundary. Preserve pending mutations; journals are not disposable caches. */
export interface ConsolidationTransitionStore {
  captureOwner(): { readonly userId: string; readonly generation: number };
  advanceEpoch(expectedGeneration: number): number | null;
  isCurrent(generation: number): boolean;
  pauseAndDrain(generation: number): Promise<boolean>;
  /** Idempotently stage a complete replacement credential bundle securely, before publishing any field. */
  stageCredentials(receipt: AccountConsolidationReceipt, generation: number): Promise<boolean>;
  readJournal(): Promise<ConsolidationTransitionJournal | null>;
  writeJournal(journal: ConsolidationTransitionJournal, generation: number): Promise<boolean>;
  /** Publish only the durably staged complete bundle; recovery must not depend on in-memory response data. */
  publishCredentials(generation: number): Promise<boolean>;
  /** Atomically reconcile local ownership, reset derived caches and complete the journal. Never clear the outbox. */
  commitLocalOwnership(journal: ConsolidationTransitionJournal, generation: number): Promise<boolean>;
  /** Release only the pause owned by this generation. */
  resume(generation: number): Promise<void>;
}

/**
 * Coordinates only a receipt already verified against the authenticated server
 * response. It grants no authentication and must never process arbitrary input.
 * Failure leaves sync paused and the durable journal available for recovery.
 */
export async function transitionConsolidatedOwner(
  receipt: AccountConsolidationReceipt,
  store: ConsolidationTransitionStore,
): Promise<'completed' | 'superseded'> {
  const owner = store.captureOwner();
  if (
    receipt.fromUserId === receipt.toUserId ||
    (owner.userId !== receipt.fromUserId && owner.userId !== receipt.toUserId)
  ) {
    throw new Error('Consolidation owner mismatch');
  }
  // Fence old HTTP/WS/outbox continuations synchronously, before the first await.
  const generation = store.advanceEpoch(owner.generation);
  if (generation === null) return 'superseded';
  const current = () => store.isCurrent(generation);
  if (!(await store.pauseAndDrain(generation))) return 'superseded';
  if (!current()) return 'superseded';
  const previous = await store.readJournal();
  if (!current()) return 'superseded';
  if (
    previous &&
    (previous.mergeId !== receipt.mergeId ||
      previous.fromUserId !== receipt.fromUserId ||
      previous.toUserId !== receipt.toUserId)
  )
    throw new Error('Consolidation journal mismatch');
  if (!previous && owner.userId === receipt.toUserId) {
    // Without a prepared journal there is no authority to reassign old local rows.
    throw new Error('Consolidation recovery journal missing');
  }
  const prepared: ConsolidationTransitionJournal = { ...receipt, phase: 'prepared' };
  if (!previous) {
    if (!(await store.stageCredentials(receipt, generation)) || !current()) return 'superseded';
    if (!(await store.writeJournal(prepared, generation))) return 'superseded';
  }
  if (!current()) return 'superseded';
  // A target JWT can be visible before the rest of its credential bundle.
  // Re-publish the complete durable bundle on recovery under the same epoch.
  if (!(await store.publishCredentials(generation)) || !current()) return 'superseded';
  const published: ConsolidationTransitionJournal = { ...receipt, phase: 'credentials-published' };
  if (!(await store.writeJournal(published, generation))) return 'superseded';
  if (!current()) return 'superseded';
  if (!(await store.commitLocalOwnership(published, generation))) return 'superseded';
  if (!current()) return 'superseded';
  await store.resume(generation);
  return current() ? 'completed' : 'superseded';
}
