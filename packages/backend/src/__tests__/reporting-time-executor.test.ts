import { expect, it, vi } from 'vite-plus/test';
import { resolveGymReportingTimeZone } from '../services/gym-reporting-time-zone';
import type { ReportingTimeZoneExecutor } from '../services/reporting-time';

const poolExecute = vi.hoisted(() => vi.fn().mockRejectedValue(new Error('No spare pool connection')));
vi.mock('../db/client', () => ({ db: { execute: poolExecute } }));

it('loads the cold PostgreSQL timezone cache through the already-held transaction connection', async () => {
  const transactionExecute = vi.fn().mockResolvedValue([{ name: 'Europe/Amsterdam' }]);
  const transaction = { execute: transactionExecute } as unknown as ReportingTimeZoneExecutor;
  expect(
    await resolveGymReportingTimeZone(
      { reportingTimeZone: null, latitude: 52.3676, longitude: 4.9041, address: null, isPublic: true, isListed: true },
      transaction,
    ),
  ).toBe('Europe/Amsterdam');
  expect(transactionExecute).toHaveBeenCalledTimes(1);
  expect(poolExecute).not.toHaveBeenCalled();
});
