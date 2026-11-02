import { getLatestClimbMutationKey, hasPendingTickForClimb } from '@boardsesh/offline-sync';
import { getDatabaseHandle } from '../db';

/** A direct server delete must not strand this device's unsent climb edits or ticks. */
export async function assertClimbDeleteReady(climb: { uuid: string; boardType: string }): Promise<void> {
  if (climb.boardType !== 'spray') return;
  const db = getDatabaseHandle();
  if (!db) return;
  if (await getLatestClimbMutationKey(db, climb.boardType, climb.uuid)) {
    throw new Error('Sync your saved climb before deleting it');
  }
  if (await hasPendingTickForClimb(db, climb.uuid, { includeDeadLetters: true })) {
    throw Object.assign(new Error('Sync your logged climbs before deleting this climb'), {
      extensions: { code: 'CLIMB_HAS_TICKS' },
    });
  }
}
