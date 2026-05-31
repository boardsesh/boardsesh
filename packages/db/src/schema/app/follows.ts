import { pgTable, bigserial, text, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../auth/users';
import { playlists } from './playlists';

export const userFollows = pgTable(
  'user_follows',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    followerId: text('follower_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    followingId: text('following_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    // Phase 2 sync: maintained by a BEFORE UPDATE trigger (migration 0109).
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueFollow: uniqueIndex('unique_user_follow').on(table.followerId, table.followingId),
    followerIdx: index('user_follows_follower_idx').on(table.followerId),
    followingIdx: index('user_follows_following_idx').on(table.followingId),
    // Composite-cursor index for syncUserFollows (offline sync pull). Resolver
    // filters `follower_id = $userId`, orders (updated_at, id).
    syncCursorIdx: index('user_follows_sync_cursor_idx').on(table.followerId, table.updatedAt, table.id),
    noSelfFollow: check('no_self_follow', sql`${table.followerId} != ${table.followingId}`),
  }),
);

export type UserFollow = typeof userFollows.$inferSelect;
export type NewUserFollow = typeof userFollows.$inferInsert;

export const setterFollows = pgTable(
  'setter_follows',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    followerId: text('follower_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    setterUsername: text('setter_username').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    // Phase 2 sync: maintained by a BEFORE UPDATE trigger (migration 0109).
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueFollow: uniqueIndex('unique_setter_follow').on(table.followerId, table.setterUsername),
    followerIdx: index('setter_follows_follower_idx').on(table.followerId),
    setterIdx: index('setter_follows_setter_idx').on(table.setterUsername),
    // Composite-cursor index for syncSetterFollows (offline sync pull). Resolver
    // filters `follower_id = $userId`, orders (updated_at, id).
    syncCursorIdx: index('setter_follows_sync_cursor_idx').on(table.followerId, table.updatedAt, table.id),
  }),
);

export type SetterFollow = typeof setterFollows.$inferSelect;
export type NewSetterFollow = typeof setterFollows.$inferInsert;

export const playlistFollows = pgTable(
  'playlist_follows',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    followerId: text('follower_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    playlistUuid: text('playlist_uuid')
      .references(() => playlists.uuid, { onDelete: 'cascade' })
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    // Phase 2 sync: maintained by a BEFORE UPDATE trigger (migration 0109).
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueFollow: uniqueIndex('unique_playlist_follow').on(table.followerId, table.playlistUuid),
    followerIdx: index('playlist_follows_follower_idx').on(table.followerId),
    playlistIdx: index('playlist_follows_playlist_idx').on(table.playlistUuid),
    // Composite-cursor index for syncPlaylistFollows (offline sync pull). Resolver
    // filters `follower_id = $userId`, orders (updated_at, id).
    syncCursorIdx: index('playlist_follows_sync_cursor_idx').on(table.followerId, table.updatedAt, table.id),
  }),
);

export type PlaylistFollow = typeof playlistFollows.$inferSelect;
export type NewPlaylistFollow = typeof playlistFollows.$inferInsert;
