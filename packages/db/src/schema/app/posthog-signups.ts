import { count, sql } from 'drizzle-orm';
import { bigint, date, pgSchema, QueryBuilder } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

export const posthogReportingSchema = pgSchema('posthog_reporting');

// created_at stores UTC as a timestamp without time zone. Casting directly to
// date keeps the signup day independent of the connection's session timezone.
const signupDay = sql<string>`cast(${users.createdAt} as date)`;
const signupCounts = new QueryBuilder()
  .select({ day: signupDay.as('day'), signups: count().as('signups') })
  .from(users)
  .groupBy(signupDay);

// Export aggregate counts only: this relation exposes no account identifiers,
// contact details, authentication data, or individual signup timestamps.
export const posthogDailySignups = posthogReportingSchema
  .view('daily_signups', {
    day: date('day').notNull(),
    signups: bigint('signups', { mode: 'number' }).notNull(),
  })
  .as(signupCounts.getSQL());
