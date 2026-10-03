import { boolean, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';
import { notifications } from './notifications';

/** One installation belongs to the account currently signed into it. */
export const notificationDevices = pgTable(
  'notification_devices',
  {
    installationId: text('installation_id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    platform: text('platform').notNull(),
    locale: text('locale').notNull(),
    active: boolean('active').default(true).notNull(),
    // Existing registrations expire immediately until an authenticated refresh.
    expiresAt: timestamp('expires_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index('notification_devices_user_idx').on(table.userId),
    tokenIdx: index('notification_devices_token_idx').on(table.token),
  }),
);

/** Persist the target token so account switches cannot retarget a queued alert. */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: text('id').primaryKey(),
    notificationUuid: text('notification_uuid')
      .notNull()
      .references(() => notifications.uuid, { onDelete: 'cascade' }),
    installationId: text('installation_id')
      .notNull()
      .references(() => notificationDevices.installationId, { onDelete: 'cascade' }),
    recipientId: text('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    locale: text('locale').notNull(),
    status: text('status').$type<'pending' | 'receipt' | 'done' | 'skipped'>().default('pending').notNull(),
    ticketId: text('ticket_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    targetIdx: uniqueIndex('notification_deliveries_target_idx').on(table.notificationUuid, table.installationId),
  }),
);
