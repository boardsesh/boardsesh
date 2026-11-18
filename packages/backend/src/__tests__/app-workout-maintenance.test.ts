import type { PgBoss } from 'pg-boss';
import { describe, expect, it, vi } from 'vite-plus/test';
import { APP_WORKOUT_EXPIRY_QUEUE, SESSION_INACTIVITY_QUEUE } from '@boardsesh/db/job-queue-schema';
import { startAppWorkoutMaintenance, startSessionInactivityMaintenance } from '../services/app-workout-maintenance';

describe('workout and session maintenance registration', () => {
  it('registers inactivity independently when workout scheduling fails', async () => {
    const schedule = vi.fn(async (name: string) => {
      if (name === APP_WORKOUT_EXPIRY_QUEUE) throw new Error('schedule unavailable');
    });
    const work = vi.fn(async () => undefined);
    const boss = { schedule, work } as unknown as PgBoss;
    await expect(startAppWorkoutMaintenance(boss)).rejects.toThrow('schedule unavailable');
    await expect(startSessionInactivityMaintenance(boss)).resolves.toBeUndefined();
    expect(work).toHaveBeenCalledWith(SESSION_INACTIVITY_QUEUE, expect.any(Function));
  });

  it('schedules bounded expiry and receipt cleanup every minute', async () => {
    const schedule = vi.fn(async () => undefined);
    const boss = { schedule, work: vi.fn(async () => undefined) } as unknown as PgBoss;
    await startAppWorkoutMaintenance(boss);
    expect(schedule).toHaveBeenCalledWith(APP_WORKOUT_EXPIRY_QUEUE, '* * * * *', null, { tz: 'UTC' });
  });
});
