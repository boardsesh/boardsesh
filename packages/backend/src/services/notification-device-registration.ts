import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { DbInstance } from '@boardsesh/db/client';
import { notificationDevices, users } from '@boardsesh/db/schema';
import { NOTIFICATION_DEVICE_TOKEN_LOCK_SEED } from './notification-locks';

export type NotificationDeviceInput = Pick<
  typeof notificationDevices.$inferInsert,
  'installationId' | 'token' | 'platform' | 'locale'
>;

/**
 * How long a registration waits for any one lock before giving up with 55P03.
 * The app registers on every launch and foreground, and a failed registration
 * is retried on the next foreground (`device-registration.ts` answers any error
 * with `false` and leaves the device unregistered). So waiting long buys
 * nothing, while a waiting registration holds one of a process's five pool
 * connections and KEY SHARE on its climber's `users` row. Sign-out, reset and
 * deletion wait up to 4 s for that row (`transactionSettings`); a sign-out
 * queued behind a registration that is itself stuck behind a long account
 * deletion still has 3 s left. The writers it normally waits behind (sign-out,
 * reset, another registration) finish in milliseconds.
 */
export const NOTIFICATION_DEVICE_LOCK_TIMEOUT = '1000ms';

/**
 * Saves one installation for `userId` and retires every other live
 * installation holding its push token. A reinstall can rotate its installation
 * id while keeping its token, and the token can come from another climber's
 * account (the same phone, someone else signed in).
 *
 * Lock order (#7645), the users-first order sign-out, password reset and
 * account deletion follow: the token lock; `users` FOR KEY SHARE, in id order,
 * for the climber and for each climber that owned a touched row when that
 * statement ran; then the touched device rows FOR NO KEY UPDATE in
 * installation id order; then the upsert of the climber's own row, which takes
 * no stronger lock. Touched rows are the live rows holding the token, plus the
 * climber's own installation. Inactive rows are left alone, so the work and
 * the locks grow with live rows only.
 *
 * Each of those writers takes its climber's `users` row FOR UPDATE (or deletes
 * it) before that climber's devices. KEY SHARE conflicts with both, so the
 * second to arrive queues on the `users` row. Sign-in, refresh and foreign-key
 * checks take KEY SHARE too, so they never wait on a registration.
 */
export async function saveNotificationDevice(
  database: DbInstance,
  userId: string,
  device: NotificationDeviceInput,
  expiresAt: Date,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.execute(sql.raw(`SET LOCAL lock_timeout = '${NOTIFICATION_DEVICE_LOCK_TIMEOUT}'`));
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${device.token}, ${NOTIFICATION_DEVICE_TOKEN_LOCK_SEED}))`,
    );
    const liveTokenRows = and(eq(notificationDevices.token, device.token), eq(notificationDevices.active, true));
    const touchedDevices = or(liveTokenRows, eq(notificationDevices.installationId, device.installationId));
    // The token lock keeps the live token rows and their owners fixed until
    // commit: only a registration for this token can add or reassign one, and
    // a row that leaves the token or goes inactive drops out of the ordered
    // lock below. The climber's own row is the exception: a registration for
    // the same installation with another token can hand it to a third climber
    // after this read, so it may be locked without its new owner's `users`
    // row. That cannot close a cycle: after locking it this registration waits
    // only for device rows later in installation id order, whose owners' rows
    // it does hold (so no sign-out or deletion of theirs is running) and which
    // other registrations take in the same order. The new owner's sign-out
    // just waits for this registration to commit.
    // IN (a UNION) stays on primary-key lookups; `id = $1 OR id IN (...)`
    // would scan the whole users table.
    await transaction
      .select({ id: users.id })
      .from(users)
      .where(
        inArray(
          users.id,
          transaction
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, userId))
            .union(
              transaction.select({ id: notificationDevices.userId }).from(notificationDevices).where(touchedDevices),
            ),
        ),
      )
      .orderBy(asc(users.id))
      .for('key share', { of: users });
    const lockedDevices = transaction
      .$with('locked_devices')
      .as(
        transaction
          .select({ installationId: notificationDevices.installationId })
          .from(notificationDevices)
          .where(touchedDevices)
          .orderBy(asc(notificationDevices.installationId))
          .for('no key update'),
      );
    await transaction
      .with(lockedDevices)
      .update(notificationDevices)
      .set({ active: false, updatedAt: new Date() })
      .from(lockedDevices)
      .where(
        and(
          eq(notificationDevices.installationId, lockedDevices.installationId),
          liveTokenRows,
          ne(notificationDevices.installationId, device.installationId),
        ),
      );
    // The conflict target is the primary key, so `set` leaves it out: naming a
    // key column would make ON CONFLICT lock the row FOR UPDATE, which waits
    // for the KEY SHARE a notification delivery insert holds on it.
    await transaction
      .insert(notificationDevices)
      .values({ ...device, userId, expiresAt })
      .onConflictDoUpdate({
        target: notificationDevices.installationId,
        set: {
          userId,
          token: device.token,
          platform: device.platform,
          locale: device.locale,
          active: true,
          expiresAt,
          updatedAt: new Date(),
        },
      });
  });
}
