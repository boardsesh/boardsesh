import { pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
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
  displayName: text('display_name'), // Custom display name (optional, falls back to users.name)
  avatarUrl: text('avatar_url'), // URL to avatar image (S3 or external)
  instagramUrl: text('instagram_url'), // Instagram profile URL (optional)
  // How this climber appears in the app's own ranked surfaces (Standings).
  leaderboardVisibility: leaderboardVisibilityEnum('leaderboard_visibility').default('public').notNull(),
  // How this climber appears on gym-operated screens — the kiosk leaderboard
  // rail and wall feeds. Deliberately independent of `leaderboardVisibility`:
  // a gym screen is read by people already standing in the room, so climbers
  // reasonably answer it differently from a leaderboard strangers can open.
  // Defaults to `public` because the kiosk rail already publishes names today,
  // so no gym running one sees its rail change under it.
  gymScreenVisibility: leaderboardVisibilityEnum('gym_screen_visibility').default('public').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
