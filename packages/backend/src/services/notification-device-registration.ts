import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { DbInstance } from '@boardsesh/db/client';
import { notificationDevices, users } from '@boardsesh/db/schema';
import { NOTIFICATION_DEVICE_TOKEN_LOCK_SEED } from './notification-locks';

export type NotificationDeviceInput = Pick<
  typeof notificationDevices.$inferInsert,
  'installationId' | 'token' | 'platform' | 'locale'
>;

/**
 * Saves one installation for `userId` and retires every other installation
 * holding its push token. A reinstall can rotate its installation id while
 * keeping its token, and the token can come from another climber's account
 * (the same phone, someone else signed in).
 *
 * Lock order (#7645), the one sign-out, password reset and account deletion
 * follow: the token lock, then `users` FOR KEY SHARE for the climber and every
 * current owner of a row this touches, by id, then those device rows by
 * installation id. Each of those writers takes its climber's `users` row FOR
 * UPDATE (or deletes it) before that climber's devices, which KEY SHARE
 * excludes, so whichever arrives second queues on the `users` row. Sign-in,
 * refresh and foreign-key checks take KEY SHARE too, so they never wait on a
 * registration. Taking the device rows in one ordered statement keeps two
 * registrations that trade tokens from locking each other's rows crosswise.
 */
export async function saveNotificationDevice(
  database: DbInstance,
  userId: string,
  device: NotificationDeviceInput,
  expiresAt: Date,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${device.token}, ${NOTIFICATION_DEVICE_TOKEN_LOCK_SEED}))`,
    );
    const touchedDevices = or(
      eq(notificationDevices.token, device.token),
      eq(notificationDevices.installationId, device.installationId),
    );
    // Under the token lock no other registration can give a row this token,
    // so the owners read here are the owners of every token row updated below.
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
          eq(notificationDevices.token, device.token),
          ne(notificationDevices.installationId, device.installationId),
        ),
      );
    await transaction
      .insert(notificationDevices)
      .values({ ...device, userId, expiresAt })
      .onConflictDoUpdate({
        target: notificationDevices.installationId,
        set: { ...device, userId, active: true, expiresAt, updatedAt: new Date() },
      });
  });
}
