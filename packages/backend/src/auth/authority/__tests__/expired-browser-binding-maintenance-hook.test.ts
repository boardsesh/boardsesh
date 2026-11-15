import type { DbInstance } from '@boardsesh/db/client';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
const dependencies = vi.hoisted(() => ({ retirement: vi.fn(), warn: vi.fn() }));
vi.mock('../expired-browser-binding-maintenance', () => ({
  runExpiredBrowserBindingRetirementMaintenance: dependencies.retirement,
}));
vi.mock('../native-browser-handoff-maintenance', () => ({ runNativeBrowserHandoffMaintenance: vi.fn() }));
vi.mock('../first-password-maintenance', () => ({ runFirstPasswordPreparationMaintenance: vi.fn() }));
vi.mock('../../current-store/command-context', () => ({ deleteExpiredCommandClaims: vi.fn() }));
vi.mock('../../current-store/email-reservations', () => ({ purgeRetiredEmailKeys: vi.fn() }));
vi.mock('../../../utils/logger', () => ({ logger: { warn: dependencies.warn } }));
vi.mock('../../../services/job-queue-client', () => ({ MAINTENANCE_POLLING_INTERVAL_SECONDS: 60 }));
import { clearExpiredAuthRecords } from '../../../services/background-job-maintenance';
const database = Object.freeze({ ownedMaintenance: true }) as unknown as DbInstance;
beforeEach(() => {
  vi.clearAllMocks();
  dependencies.retirement.mockReset();
});
describe('existing worker awaits expired-binding receipt maintenance', () => {
  it('retains the existing awaited shutdown boundary with no new interval', async () => {
    let release!: () => void;
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    dependencies.retirement.mockImplementation(() => {
      signalEntered();
      return held;
    });
    let finished = false;
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const pending = clearExpiredAuthRecords(database).finally(() => {
      finished = true;
    });
    try {
      await entered;
      expect(finished).toBe(false);
      expect(intervals).not.toHaveBeenCalled();
      release();
      await pending;
      expect(finished).toBe(true);
    } finally {
      release();
      await pending;
      intervals.mockRestore();
    }
  });
  it('contains private failure causes and permits the next existing worker tick', async () => {
    dependencies.retirement
      .mockRejectedValueOnce(new Error('private actual token SQL parameters'))
      .mockResolvedValueOnce(0);
    await expect(clearExpiredAuthRecords(database)).resolves.toBeUndefined();
    expect(dependencies.warn).toHaveBeenCalledExactlyOnceWith('Expired browser binding receipt cleanup unavailable');
    await clearExpiredAuthRecords(database);
    expect(dependencies.retirement).toHaveBeenCalledTimes(2);
    expect(dependencies.warn).toHaveBeenCalledTimes(1);
  });
});
