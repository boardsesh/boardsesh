import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotificationPushHealthReporter, type NotificationPushHealth } from '../notification-push-health';
import { logger } from '../../utils/logger';

vi.mock('../../db/client', () => ({ db: {} }));

const stalled: NotificationPushHealth = {
  updatedLast24h: { pending: 3, receipt: 0, done: 0, skipped: 2 },
  outstanding: { pending: 5, receipt: 1 },
  oldestOutstandingUpdateAgeSeconds: 3601,
};

afterEach(() => vi.restoreAllMocks());

describe('notification push health reporting', () => {
  it('alerts for stale outstanding deliveries with no confirmed receipts, at most hourly', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const summaryLog = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const readSnapshot = vi.fn().mockResolvedValue(stalled);
    let now = 1_000_000;
    const report = createNotificationPushHealthReporter(readSnapshot, () => now);
    await report();
    await report();
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(summaryLog).toHaveBeenCalledWith('Expo push delivery health', {
      event: 'notification.push.health',
      ...stalled,
    });
    expect(errorLog).toHaveBeenCalledWith('Expo push delivery stalled', {
      event: 'notification.push.stalled',
      ...stalled,
      error: expect.objectContaining({ message: 'PUSH_DELIVERY_STALLED' }),
    });
    now += 60 * 60_000;
    await report();
    expect(errorLog).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...stalled, oldestOutstandingUpdateAgeSeconds: 3600 },
    { ...stalled, outstanding: { pending: 0, receipt: 0 } },
    { ...stalled, updatedLast24h: { ...stalled.updatedLast24h, done: 1 } },
  ])('does not alert for a healthy or empty queue: %j', async (snapshot) => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    vi.spyOn(logger, 'info').mockImplementation(() => logger);
    await createNotificationPushHealthReporter(async () => snapshot)();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('contains and throttles database failures without logging their raw messages', async () => {
    const warningLog = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const readSnapshot = vi.fn().mockRejectedValue(new Error('query containing secret'));
    const report = createNotificationPushHealthReporter(readSnapshot, () => 1000);
    await expect(report()).resolves.toBeUndefined();
    await report();
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(warningLog).toHaveBeenCalledWith('Expo push health query failed', {
      event: 'notification.push.health_query_failed',
    });
    expect(JSON.stringify(warningLog.mock.calls)).not.toContain('secret');
  });
});
