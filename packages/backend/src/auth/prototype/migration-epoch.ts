import { eq } from 'drizzle-orm';
import { prototypeAuthMigrationEpoch } from '@boardsesh/db/auth-prototype';
import type { PrototypeDatabase } from './authority';

/**
 * Call inside the caller's mutation transaction and lifecycle fence. An epoch
 * has no expiry: ordinary token cleanup must never authorize another cutover.
 */
export async function ensurePrototypeMigrationEpoch(
  database: Pick<PrototypeDatabase, 'insert' | 'select'>,
  name: 'native-refresh' | 'legacy-recovery' | 'legacy-watch',
  cutoverTime: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(cutoverTime) || cutoverTime > Date.now()) return false;
  const cutoverAt = new Date(cutoverTime);
  if (!Number.isFinite(cutoverAt.getTime())) return false;
  await database.insert(prototypeAuthMigrationEpoch).values({ name, cutoverAt }).onConflictDoNothing();
  const [epoch] = await database
    .select({ cutoverAt: prototypeAuthMigrationEpoch.cutoverAt })
    .from(prototypeAuthMigrationEpoch)
    .where(eq(prototypeAuthMigrationEpoch.name, name));
  return epoch?.cutoverAt.getTime() === cutoverTime;
}
