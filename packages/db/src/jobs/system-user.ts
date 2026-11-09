import { sql } from 'drizzle-orm';
import { BATCH_SYSTEM_USERS } from '../queries/system-account-constants';
import type { JobSystemUserAuthority, JobSystemUserKind, JobTransact } from './types';

/**
 * Create the reserved user a job writes shared rows under (cohort playlists,
 * shadow hold classifications), if it does not exist yet.
 *
 * Raw SQL on purpose: drizzle's insert lists every column of `users` and sends
 * DEFAULT for the ones it was not given, which needs INSERT on all of them. The
 * batch worker's login holds INSERT on `users (id, name, email)` only, so it can
 * create this row but can never write an email-verified user or a session.
 */
export async function ensureJobSystemUser(
  transact: JobTransact,
  kind: JobSystemUserKind,
  authority: JobSystemUserAuthority = { mode: 'legacy' },
): Promise<void> {
  if (kind !== 'recommendations' && kind !== 'hold-classifier')
    throw new Error('Batch system user authority unavailable');
  if (!authority || typeof authority !== 'object') throw new Error('Batch system user authority unavailable');
  if (authority.mode === 'backend-staging') {
    if (typeof authority.ensure !== 'function') throw new Error('Batch system user authority unavailable');
    await authority.ensure(kind);
    return;
  }
  if (authority.mode !== 'legacy') throw new Error('Batch system user authority unavailable');
  const user = BATCH_SYSTEM_USERS[kind];
  await transact(async (transaction) => {
    await transaction.execute(sql`
      INSERT INTO users (id, name, email)
      VALUES (${user.id}, ${user.name}, ${user.email})
      ON CONFLICT (id) DO NOTHING
    `);
  });
}
