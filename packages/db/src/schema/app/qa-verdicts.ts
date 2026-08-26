import { pgTable, text, integer, timestamp, bigserial, bigint, index, pgEnum } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

/**
 * A tester's call on a pull-request preview: it works, or it doesn't. See
 * docs/crowdsourced-qa.md.
 */
export const qaVerdictKindEnum = pgEnum('qa_verdict_kind', ['approved', 'declined']);

/**
 * One verdict a tester filed from the mobile app after loading a PR's `pr-<n>`
 * OTA preview branch. The row is the record; the GitHub comment and the
 * qa-approved/qa-declined label are a best-effort mirror written afterwards, so
 * `github_comment_id IS NULL` means the sync did not land (see the runbook in
 * docs/crowdsourced-qa.md), never that the verdict was lost.
 *
 * Device context (platform, app version, update id, runtime, bundle date) is
 * what the GitHub comment reports as "tested where" — and `bundle_created_at`
 * against `head_committed_at` is what flags a verdict filed on a stale bundle.
 */
export const qaVerdicts = pgTable(
  'qa_verdicts',
  {
    id: bigserial({ mode: 'number' }).primaryKey().notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    prNumber: integer('pr_number').notNull(),
    /** The OTA preview branch the tester ran, always `pr-<pr_number>`. */
    branch: text('branch').notNull(),
    /** The PR's head commit when the verdict was filed. */
    headSha: text('head_sha'),
    /** Committer date of `head_sha`; null when the GitHub lookup failed. */
    headCommittedAt: timestamp('head_committed_at', { mode: 'string' }),
    verdict: qaVerdictKindEnum('verdict').notNull(),
    comment: text('comment'),
    platform: text('platform').notNull(),
    appVersion: text('app_version'),
    updateId: text('update_id'),
    runtimeVersion: text('runtime_version'),
    /** expo-updates `createdAt` of the bundle the tester was running. */
    bundleCreatedAt: timestamp('bundle_created_at', { mode: 'string' }),
    githubCommentId: bigint('github_comment_id', { mode: 'number' }),
    githubCommentUrl: text('github_comment_url'),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => ({
    prCreatedIdx: index('qa_verdicts_pr_created_idx').on(table.prNumber, table.createdAt),
    userIdx: index('qa_verdicts_user_idx').on(table.userId),
  }),
);

export type QaVerdictRow = typeof qaVerdicts.$inferSelect;
export type NewQaVerdictRow = typeof qaVerdicts.$inferInsert;
