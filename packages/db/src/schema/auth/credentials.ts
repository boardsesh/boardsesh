import { pgEnum, pgTable, text, timestamp, boolean, integer } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * How a climber appears on a ranked surface.
 *
 * - `public`   — display name, avatar and score, tappable through to the profile.
 * - `anonymous` — the climber still ranks and still counts toward the field size,
 *   but everyone else sees "A climber" beside the score.
 * - `off`      — no rank, no row, and excluded from the denominator. They can
 *   still read every list and still see their own numbers.
 *
 * Applied inside the ranking window function rather than as a post-filter, so a
 * hidden climber does not silently shift everyone else's rank.
 */
export const leaderboardVisibilityEnum = pgEnum('leaderboard_visibility', ['public', 'anonymous', 'off']);

// User credentials for email/password authentication
// Kept separate from NextAuth users table to maintain adapter compatibility
export const userCredentials = pgTable('user_credentials', {
  userId: text('user_id')
    .notNull()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// User profiles for display name and avatar customization
export const userProfiles = pgTable('user_profiles', {
  userId: text('user_id')
    .notNull()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  isPrivate: boolean('is_private').default(false).notNull(),
  privacyRevision: integer('privacy_revision').default(0).notNull(),
  privacyOnboardingVersion: integer('privacy_onboarding_version').default(0).notNull(),
  defaultSessionAudience: text('default_session_audience').$type<'public' | 'followers' | 'invite_only' | 'only_me'>(),
  // Board-facing surfaces (wall feed, leaderboard, live roster) show this climber
  // as anonymous on every board they don't own. Read-time only: ticks and
  // board history are stored and counted exactly as before.
  anonymousOnForeignBoards: boolean('anonymous_on_foreign_boards').default(false).notNull(),
  displayName: text('display_name'), // Custom display name (optional, falls back to users.name)
  avatarUrl: text('avatar_url'), // URL to avatar image (S3 or external)
  instagramUrl: text('instagram_url'), // Instagram profile URL (optional)
  // How this climber appears in the app's own ranked surfaces (Standings).
  leaderboardVisibility: leaderboardVisibilityEnum('leaderboard_visibility').default('public').notNull(),
  // Additional restrictions for gym-screen rankings. The server applies the
  // stricter of this and leaderboardVisibility; both retain account, tick and
  // foreign-board anonymity rules. Ordinary board history is unaffected.
  gymScreenVisibility: leaderboardVisibilityEnum('gym_screen_visibility').default('public').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
