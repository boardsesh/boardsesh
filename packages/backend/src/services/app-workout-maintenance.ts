import type { PgBoss } from 'pg-boss';
import { APP_WORKOUT_EXPIRY_QUEUE, SESSION_INACTIVITY_QUEUE } from '@boardsesh/db/job-queue-schema';
import { db } from '../db/client';
import type { PartnerDatabase } from '../auth/partner/tables';
import { expireAppWorkouts } from './public-api/workout-lifecycle';
import { roomManager } from './room-manager';

export async function startAppWorkoutMaintenance(boss: PgBoss): Promise<void> {
  await boss.schedule(APP_WORKOUT_EXPIRY_QUEUE, '* * * * *', null, { tz: 'UTC' });
  await boss.work(APP_WORKOUT_EXPIRY_QUEUE, async () => {
    try {
      await db.transaction((tx) => expireAppWorkouts(tx as unknown as PartnerDatabase));
    } catch {
      throw new Error('APP_WORKOUT_EXPIRY_FAILED');
    }
  });
}

/** Register independently: workout maintenance failures must not stop session closure. */
export async function startSessionInactivityMaintenance(boss: PgBoss): Promise<void> {
  await boss.schedule(SESSION_INACTIVITY_QUEUE, '* * * * *', null, { tz: 'UTC' });
  await boss.work(SESSION_INACTIVITY_QUEUE, async () => {
    try {
      await roomManager.runInactivitySweep();
    } catch {
      throw new Error('SESSION_INACTIVITY_FAILED');
    }
  });
}
