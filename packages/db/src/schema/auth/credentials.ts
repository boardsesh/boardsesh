import {
  boolean,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { users } from './users';

// User credentials for email/password authentication
// Kept separate from NextAuth users table to maintain adapter compatibility
export const userCredentials = pgTable("user_credentials", {
  userId: text("user_id")
    .notNull()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// User profiles for display name and avatar customization
export const userProfiles = pgTable("user_profiles", {
  userId: text("user_id")
    .notNull()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name"), // Custom display name (optional, falls back to users.name)
  avatarUrl: text("avatar_url"), // URL to avatar image (S3 or external)
  instagramUrl: text("instagram_url"), // Instagram profile URL (optional)
  isPrivate: boolean("is_private").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
