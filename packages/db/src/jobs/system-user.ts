import { sql } from 'drizzle-orm';
import type { JobDatabase } from './types';

/**
 * Create the reserved user a job writes shared rows under (cohort playlists,
 * shadow hold classifications), if it does not exist yet.
 *
 * Raw SQL on purpose: drizzle's insert lists every column of `users` and sends
 * DEFAULT for the ones it was not given, which needs INSERT on all of them. The
 * batch worker's login holds INSERT on `users (id, name, email)` only, so it can
 * create this row but can never write an email-verified user or a session.
 */
export async function ensureSystemUser(
  db: JobDatabase,
  user: { id: string; name: string; email: string },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, name, email)
    VALUES (${user.id}, ${user.name}, ${user.email})
    ON CONFLICT (id) DO NOTHING
  `);
}
