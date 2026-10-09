// Provider-independent crash recovery. The owner retains native ownership after
// the caller's deadline until native work settles.
import type { OtaOperationLease, OtaOperationRunner } from './ota-operation-owner';

export type OtaRecoveryResult =
  | 'reloaded-update'
  | 'reloaded-rollback'
  | 'reloaded-pending'
  | 'no-fix-available'
  | 'failed';
export type OtaRecoveryPhase = 'checking' | 'downloading';

export type OtaRecoveryDeps<Receipt = unknown, FetchResult = unknown> = {
  runOperation: OtaOperationRunner;
  waitForIdle?: (lease: OtaOperationLease) => Promise<void>;
  checkForUpdate: () => Promise<{ isAvailable: boolean; isRollBackToEmbedded: boolean }>;
  fetchUpdate: () => Promise<FetchResult>;
  reload: () => Promise<void>;
  captureReloadReceipt: () => Receipt | null;
  waitForReloadReceipt?: (lease: OtaOperationLease, fetched: FetchResult) => Promise<Receipt | null>;
  isReloadReceiptCurrent: (receipt: Receipt) => boolean;
};
export type OtaRecoveryOptions = {
  onPhase?: (phase: OtaRecoveryPhase) => void;
  onBeforeReload?: (result: OtaRecoveryResult) => void;
  timeoutMs?: number;
};

/** Check and apply a known-safe update, rollback, or pending download. */
export async function performOtaRecovery<Receipt, FetchResult>(
  deps: OtaRecoveryDeps<Receipt, FetchResult>,
  options?: OtaRecoveryOptions,
): Promise<{ result: OtaRecoveryResult; error?: unknown }> {
  try {
    const result = await deps.runOperation(
      async (lease): Promise<OtaRecoveryResult> => {
        await deps.waitForIdle?.(lease);
        lease.assertActive();
        options?.onPhase?.('checking');
        const check = await lease.native(deps.checkForUpdate);
        let outcome: OtaRecoveryResult = 'reloaded-pending';
        let receipt: Receipt | null;
        if (check.isAvailable || check.isRollBackToEmbedded) {
          lease.assertActive();
          options?.onPhase?.('downloading');
          const fetched = await lease.native(deps.fetchUpdate);
          receipt = deps.waitForReloadReceipt
            ? await deps.waitForReloadReceipt(lease, fetched)
            : deps.captureReloadReceipt();
          outcome = check.isAvailable ? 'reloaded-update' : 'reloaded-rollback';
        } else {
          receipt = deps.captureReloadReceipt();
        }
        lease.assertActive();
        // Native pending state alone cannot prove which pin downloaded a bundle.
        if (receipt === null || !deps.isReloadReceiptCurrent(receipt)) return 'no-fix-available';
        lease.assertActive();
        options?.onBeforeReload?.(outcome);
        await lease.reload(deps.reload);
        return outcome;
      },
      { timeoutMs: options?.timeoutMs ?? 30_000 },
    );
    return { result };
  } catch (error) {
    return { result: 'failed', error };
  }
}
