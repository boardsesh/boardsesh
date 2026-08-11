import React from 'react';
import { sql } from 'drizzle-orm';
import Container from '@mui/material/Container';
import Alert from '@mui/material/Alert';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { dbz, executeRows } from '@/app/lib/db/db';
import { checkAdmin } from '@/app/lib/admin/check-admin';
import RetentionDashboard, { type RetentionRow } from './retention-dashboard';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('admin');
  return createNoIndexMetadata({
    title: t('metadata.retention.title'),
    description: t('metadata.retention.description'),
    path: '/admin/retention',
    locale,
  });
}

type RawRetentionRow = {
  cohort_week: string;
  signups: number;
  d1_count: number;
  d3_count: number;
  d7_count: number;
  d30_count: number;
  activated_count: number;
  d1_pct: string | null;
  d3_pct: string | null;
  d7_pct: string | null;
  d30_pct: string | null;
  activation_pct: string | null;
  d1_any_count: number;
  d3_any_count: number;
  d7_any_count: number;
  d30_any_count: number;
  activated_any_count: number;
  d1_any_pct: string | null;
  d3_any_pct: string | null;
  d7_any_pct: string | null;
  d30_any_pct: string | null;
  activation_any_pct: string | null;
};

async function fetchRetention(): Promise<RetentionRow[]> {
  // Cohort = week-of-signup (UTC, Monday-anchored). The d1/d3/d7/d30 columns
  // are *classic Dn retention*: a user counts toward Dn if they had activity
  // in the 24-hour window [signup + N days, signup + (N+1) days). This is
  // the Amplitude / Mixpanel / GA definition — "active on day N", not
  // "active anytime in the first N days". Day-0 (the signup day itself) is
  // not counted toward D1; that's intentional and standard for retention
  // triangles. Two parallel definitions of "active":
  //   1. Tick activity: at least one boardsesh tick (aurora_id IS NULL —
  //      not synced in from Aurora). This is the original metric.
  //   2. Any activity: a UNION ALL of every user-attributable timestamp
  //      we record — ticks, party sessions, favorites/playlists/pins/follows,
  //      gym/board follows, controller/serial setup, comments/votes/
  //      proposals/feedback. Captures returners who don't tick.
  // Each Dn % is NULL'd until *every* user in the cohort has had time to
  // complete day N (cohort_week + 7 + N + 1 days, since the cohort spans
  // Mon–Sun and we need the latest signup to reach day N+1). The 211-day
  // prefilter on UNION branches is 180-day cohort window + 30-day Dn window
  // + 1-day slack; it lets the planner skip very old rows without changing
  // semantics. Today timestamps are read in UTC to match the cohort.
  const rows = await executeRows<RawRetentionRow>(
    dbz,
    sql`
      WITH today_utc AS (
        SELECT (NOW() AT TIME ZONE 'UTC')::date AS d
      ),
      signup_cohorts AS (
        SELECT
          id AS user_id,
          (date_trunc('week', created_at AT TIME ZONE 'UTC'))::date AS cohort_week,
          created_at
        FROM users
        WHERE created_at >= NOW() - INTERVAL '180 days'
      ),
      ticks_by_user AS (
        SELECT
          sc.user_id,
          BOOL_OR(t.climbed_at >= sc.created_at + INTERVAL '1 day'
              AND t.climbed_at <  sc.created_at + INTERVAL '2 days')  AS active_d1,
          BOOL_OR(t.climbed_at >= sc.created_at + INTERVAL '3 days'
              AND t.climbed_at <  sc.created_at + INTERVAL '4 days')  AS active_d3,
          BOOL_OR(t.climbed_at >= sc.created_at + INTERVAL '7 days'
              AND t.climbed_at <  sc.created_at + INTERVAL '8 days')  AS active_d7,
          BOOL_OR(t.climbed_at >= sc.created_at + INTERVAL '30 days'
              AND t.climbed_at <  sc.created_at + INTERVAL '31 days') AS active_d30
        FROM signup_cohorts sc
        JOIN boardsesh_ticks t
          ON t.user_id = sc.user_id
         AND t.climbed_at >= sc.created_at
         AND t.aurora_id IS NULL
        GROUP BY sc.user_id
      ),
      activity_events AS (
        SELECT user_id, climbed_at AS ts FROM boardsesh_ticks
          WHERE aurora_id IS NULL AND climbed_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT created_by_user_id AS user_id, created_at AS ts FROM board_sessions
          WHERE created_by_user_id IS NOT NULL AND created_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT user_id, joined_at AS ts FROM board_session_participants
          WHERE joined_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT user_id, created_at AS ts FROM user_favorites
          WHERE created_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT user_id, created_at AS ts FROM playlist_ownership
          WHERE created_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT user_id, created_at AS ts FROM user_playlist_pins
          WHERE created_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT follower_id AS user_id, created_at AS ts FROM user_follows
          WHERE created_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT follower_id AS user_id, created_at AS ts FROM playlist_follows
          WHERE created_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT follower_id AS user_id, created_at AS ts FROM setter_follows
          WHERE created_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT user_id, created_at AS ts FROM new_climb_subscriptions
          WHERE created_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT user_id, created_at AS ts FROM comments
          WHERE created_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT user_id, created_at AS ts FROM votes
          WHERE created_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT user_id, created_at AS ts FROM proposal_votes
          WHERE created_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT proposer_id AS user_id, created_at AS ts FROM climb_proposals
          WHERE created_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT user_id, created_at AS ts FROM gym_members
          WHERE created_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT user_id, created_at AS ts FROM gym_follows
          WHERE created_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT user_id, created_at AS ts FROM board_follows
          WHERE created_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT user_id, created_at AS ts FROM esp32_controllers
          WHERE user_id IS NOT NULL AND created_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT user_id, created_at AS ts FROM user_board_serials
          WHERE created_at >= NOW() - INTERVAL '211 days'
        UNION ALL
        SELECT user_id, created_at AS ts FROM app_feedback
          WHERE user_id IS NOT NULL AND created_at >= NOW() - INTERVAL '211 days'
      ),
      activity_by_user AS (
        SELECT
          sc.user_id,
          BOOL_OR(ae.ts >= sc.created_at + INTERVAL '1 day'
              AND ae.ts <  sc.created_at + INTERVAL '2 days')  AS active_d1,
          BOOL_OR(ae.ts >= sc.created_at + INTERVAL '3 days'
              AND ae.ts <  sc.created_at + INTERVAL '4 days')  AS active_d3,
          BOOL_OR(ae.ts >= sc.created_at + INTERVAL '7 days'
              AND ae.ts <  sc.created_at + INTERVAL '8 days')  AS active_d7,
          BOOL_OR(ae.ts >= sc.created_at + INTERVAL '30 days'
              AND ae.ts <  sc.created_at + INTERVAL '31 days') AS active_d30
        FROM signup_cohorts sc
        JOIN activity_events ae
          ON ae.user_id = sc.user_id
         AND ae.ts >= sc.created_at
        GROUP BY sc.user_id
      ),
      cohort_rollup AS (
        SELECT
          sc.cohort_week,
          COUNT(*)::int AS signups,
          COUNT(*) FILTER (WHERE tbu.active_d1)::int  AS d1_count,
          COUNT(*) FILTER (WHERE tbu.active_d3)::int  AS d3_count,
          COUNT(*) FILTER (WHERE tbu.active_d7)::int  AS d7_count,
          COUNT(*) FILTER (WHERE tbu.active_d30)::int AS d30_count,
          COUNT(*) FILTER (WHERE tbu.user_id IS NOT NULL)::int AS activated_count,
          COUNT(*) FILTER (WHERE abu.active_d1)::int  AS d1_any_count,
          COUNT(*) FILTER (WHERE abu.active_d3)::int  AS d3_any_count,
          COUNT(*) FILTER (WHERE abu.active_d7)::int  AS d7_any_count,
          COUNT(*) FILTER (WHERE abu.active_d30)::int AS d30_any_count,
          COUNT(*) FILTER (WHERE abu.user_id IS NOT NULL)::int AS activated_any_count
        FROM signup_cohorts sc
        LEFT JOIN ticks_by_user tbu USING (user_id)
        LEFT JOIN activity_by_user abu USING (user_id)
        GROUP BY sc.cohort_week
      )
      SELECT
        to_char(cr.cohort_week, 'YYYY-MM-DD') AS cohort_week,
        cr.signups,
        cr.d1_count,
        cr.d3_count,
        cr.d7_count,
        cr.d30_count,
        cr.activated_count,
        CASE WHEN cr.cohort_week + INTERVAL '9 days'  <= today_utc.d
             THEN ROUND(100.0 * cr.d1_count  / NULLIF(cr.signups, 0), 1) END AS d1_pct,
        CASE WHEN cr.cohort_week + INTERVAL '11 days' <= today_utc.d
             THEN ROUND(100.0 * cr.d3_count  / NULLIF(cr.signups, 0), 1) END AS d3_pct,
        CASE WHEN cr.cohort_week + INTERVAL '15 days' <= today_utc.d
             THEN ROUND(100.0 * cr.d7_count  / NULLIF(cr.signups, 0), 1) END AS d7_pct,
        CASE WHEN cr.cohort_week + INTERVAL '38 days' <= today_utc.d
             THEN ROUND(100.0 * cr.d30_count / NULLIF(cr.signups, 0), 1) END AS d30_pct,
        ROUND(100.0 * cr.activated_count / NULLIF(cr.signups, 0), 1) AS activation_pct,
        cr.d1_any_count,
        cr.d3_any_count,
        cr.d7_any_count,
        cr.d30_any_count,
        cr.activated_any_count,
        CASE WHEN cr.cohort_week + INTERVAL '9 days'  <= today_utc.d
             THEN ROUND(100.0 * cr.d1_any_count  / NULLIF(cr.signups, 0), 1) END AS d1_any_pct,
        CASE WHEN cr.cohort_week + INTERVAL '11 days' <= today_utc.d
             THEN ROUND(100.0 * cr.d3_any_count  / NULLIF(cr.signups, 0), 1) END AS d3_any_pct,
        CASE WHEN cr.cohort_week + INTERVAL '15 days' <= today_utc.d
             THEN ROUND(100.0 * cr.d7_any_count  / NULLIF(cr.signups, 0), 1) END AS d7_any_pct,
        CASE WHEN cr.cohort_week + INTERVAL '38 days' <= today_utc.d
             THEN ROUND(100.0 * cr.d30_any_count / NULLIF(cr.signups, 0), 1) END AS d30_any_pct,
        ROUND(100.0 * cr.activated_any_count / NULLIF(cr.signups, 0), 1) AS activation_any_pct
      FROM cohort_rollup cr
      CROSS JOIN today_utc
      ORDER BY cr.cohort_week DESC;
    `,
  );

  const toNumberOrNull = (value: string | null): number | null => (value === null ? null : Number(value));

  return rows.map((row) => ({
    cohortWeek: row.cohort_week,
    signups: row.signups,
    d1Count: row.d1_count,
    d3Count: row.d3_count,
    d7Count: row.d7_count,
    d30Count: row.d30_count,
    activatedCount: row.activated_count,
    d1Pct: toNumberOrNull(row.d1_pct),
    d3Pct: toNumberOrNull(row.d3_pct),
    d7Pct: toNumberOrNull(row.d7_pct),
    d30Pct: toNumberOrNull(row.d30_pct),
    activationPct: toNumberOrNull(row.activation_pct),
    d1AnyCount: row.d1_any_count,
    d3AnyCount: row.d3_any_count,
    d7AnyCount: row.d7_any_count,
    d30AnyCount: row.d30_any_count,
    activatedAnyCount: row.activated_any_count,
    d1AnyPct: toNumberOrNull(row.d1_any_pct),
    d3AnyPct: toNumberOrNull(row.d3_any_pct),
    d7AnyPct: toNumberOrNull(row.d7_any_pct),
    d30AnyPct: toNumberOrNull(row.d30_any_pct),
    activationAnyPct: toNumberOrNull(row.activation_any_pct),
  }));
}

export default async function AdminRetentionPage() {
  const access = await checkAdmin();
  const locale = await getLocale();
  const { t } = await getServerTranslation('admin');

  if (!access.authenticated) {
    return (
      <I18nProvider locale={locale} namespaces={['common', 'admin']}>
        <Container maxWidth="md" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
          <Alert severity="warning">{t('auth.signInRequired')}</Alert>
        </Container>
      </I18nProvider>
    );
  }

  if (!access.isAdmin) {
    return (
      <I18nProvider locale={locale} namespaces={['common', 'admin']}>
        <Container maxWidth="md" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
          <Alert severity="error">{t(access.boardScopedOnly ? 'auth.boardScopedNoAccess' : 'auth.noAccess')}</Alert>
        </Container>
      </I18nProvider>
    );
  }

  const rows = await fetchRetention();

  return (
    <I18nProvider locale={locale} namespaces={['common', 'admin']}>
      <RetentionDashboard rows={rows} />
    </I18nProvider>
  );
}
