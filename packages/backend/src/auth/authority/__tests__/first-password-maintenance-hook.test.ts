import type { DbInstance } from '@boardsesh/db/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
const dependencies = vi.hoisted(() => ({
  scrub: vi.fn(),
  claims: vi.fn(),
  nativeClaims: vi.fn(),
  emails: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('../native-browser-handoff-maintenance', () => ({
  runNativeBrowserHandoffMaintenance: dependencies.nativeClaims,
}));
vi.mock('../first-password-maintenance', () => ({ runFirstPasswordPreparationMaintenance: dependencies.scrub }));
vi.mock('../../current-store/command-context', () => ({ deleteExpiredCommandClaims: dependencies.claims }));
vi.mock('../../current-store/email-reservations', () => ({ purgeRetiredEmailKeys: dependencies.emails }));
vi.mock('../../../utils/logger', () => ({ logger: { warn: dependencies.warn } }));
vi.mock('../../../services/job-queue-client', () => ({ MAINTENANCE_POLLING_INTERVAL_SECONDS: 60 }));
import { clearExpiredAuthRecords } from '../../../services/background-job-maintenance';
const database = Object.freeze({ ownedMaintenanceHandle: true }) as unknown as DbInstance;
describe('first-password existing maintenance drain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.claims.mockResolvedValue(undefined);
    dependencies.emails.mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());
  it('keeps the existing worker promise pending until the bounded credential task drains, with no new timer', async () => {
    let release = () => {};
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    dependencies.scrub.mockImplementation(() => {
      entered();
      return held;
    });
    let finished = false;
    const timers = vi.spyOn(globalThis, 'setInterval');
    const pending = clearExpiredAuthRecords(database).finally(() => {
      finished = true;
    });
    try {
      await started;
      expect(dependencies.scrub).toHaveBeenCalledOnce();
      expect(finished).toBe(false);
      expect(timers).not.toHaveBeenCalled();
      release();
      await pending;
      expect(finished).toBe(true);
      expect(dependencies.claims).toHaveBeenCalledExactlyOnceWith(database);
      expect(dependencies.emails).toHaveBeenCalledExactlyOnceWith(database);
    } finally {
      release();
      await pending;
    }
  });
  it('keeps cleanup failures private and permits the existing next-tick retry', async () => {
    dependencies.scrub
      .mockRejectedValueOnce(new Error('synthetic private SQL credential must not be logged'))
      .mockResolvedValueOnce({ observed: 0, scrubbed: 0 });
    await expect(clearExpiredAuthRecords(database)).resolves.toBeUndefined();
    expect(dependencies.warn).toHaveBeenCalledExactlyOnceWith('First-password preparation scrub unavailable');
    await clearExpiredAuthRecords(database);
    expect(dependencies.scrub).toHaveBeenCalledTimes(2);
    expect(dependencies.warn).toHaveBeenCalledTimes(1);
  });
});
