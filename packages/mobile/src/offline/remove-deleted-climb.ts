import { isSigningOut, removeDeletedClimbLocally } from '@boardsesh/offline-sync';
import { getDatabaseHandle } from '../db';
import { isAuthCredentialGenerationCurrent } from '../lib/auth-store';
import { reportHandledError } from '../lib/error-reporting';
import { isOfflineEngineEnabled } from '../lib/offline-engine';

/**
 * Take a climb `deleteClimb` just removed off this phone's downloaded copy, so a
 * downloaded wall stops listing it now rather than after the next pull (#5960).
 *
 * Best effort: the server delete already succeeded, and the climb's tombstone
 * reaches this device on the next pull either way. A failure is reported, never
 * thrown, so the caller still closes the drawer and says the climb is gone.
 */
export async function removeDeletedClimbFromDevice(
  climb: { uuid: string; boardType: string },
  authGeneration: number,
): Promise<void> {
  const canWrite = () => isAuthCredentialGenerationCurrent(authGeneration) && !isSigningOut();
  if (!isOfflineEngineEnabled() || !canWrite()) return;
  const db = getDatabaseHandle();
  if (!db) return;
  try {
    await removeDeletedClimbLocally(db, climb, canWrite);
  } catch (error) {
    if (!canWrite()) return;
    reportHandledError(error, { tags: { source: 'offline-sync', kind: 'deleted-climb-local' } });
  }
}
