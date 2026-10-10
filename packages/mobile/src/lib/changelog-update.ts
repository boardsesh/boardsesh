import type { OtaRecoveryDeps, OtaRecoveryPhase } from './ota-recovery';

export type ChangelogUpdateResult = 'up-to-date' | 'cancelled' | 'reloaded' | 'stale' | 'failed';

/** Confirmation never holds native ownership or consumes the network budget. */
export async function performChangelogUpdate<Receipt, FetchResult>(
  deps: OtaRecoveryDeps<Receipt, FetchResult> & { confirm: () => Promise<boolean> },
  options?: { timeoutMs?: number; onPhase?: (phase: OtaRecoveryPhase | 'idle') => void },
): Promise<{ result: ChangelogUpdateResult; error?: unknown }> {
  try {
    const receipt = await deps.runOperation(
      async (lease) => {
        await deps.waitForIdle?.(lease);
        lease.assertActive();
        options?.onPhase?.('checking');
        const check = await lease.native(deps.checkForUpdate);
        if (!check.isAvailable) return null;
        lease.assertActive();
        options?.onPhase?.('downloading');
        const fetched = await lease.native(deps.fetchUpdate);
        const downloaded = deps.waitForReloadReceipt
          ? await deps.waitForReloadReceipt(lease, fetched)
          : deps.captureReloadReceipt();
        lease.assertActive();
        if (downloaded === null || !deps.isReloadReceiptCurrent(downloaded)) {
          throw new Error('Downloaded OTA is not safe for the current headers');
        }
        return downloaded;
      },
      { timeoutMs: options?.timeoutMs ?? 30_000 },
    );
    options?.onPhase?.('idle');
    if (receipt === null) return { result: 'up-to-date' };
    if (!(await deps.confirm())) return { result: 'cancelled' };
    const result = await deps.runOperation(
      async (lease): Promise<'stale' | 'reloaded'> => {
        lease.assertActive();
        if (!deps.isReloadReceiptCurrent(receipt)) return 'stale';
        await lease.reload(deps.reload);
        return 'reloaded';
      },
      { timeoutMs: options?.timeoutMs ?? 30_000 },
    );
    return { result };
  } catch (error) {
    options?.onPhase?.('idle');
    return { result: 'failed', error };
  }
}
