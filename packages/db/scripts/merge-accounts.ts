/**
 * Merge duplicate user accounts that share the same email (case-insensitively).
 *
 * `users.email` historically had no unique constraint and used the default
 * (case-sensitive) collation, so `Foo@x.com` and `foo@x.com` could create
 * separate accounts. This script collapses each `lower(email)` group down to a
 * single winner: every row owned by a loser account is repointed onto the
 * winner, then the loser `users` rows are deleted (FK cascades clean up anything
 * left behind — including rows intentionally dropped because the winner already
 * had an equivalent one).
 *
 * Winner selection: most boardsesh_ticks, then most other owned rows, then a
 * verified email, then the oldest account. The winner keeps its `users.id` so
 * existing web sessions (JWT `sub`) keep working; the losers' login methods
 * (OAuth `accounts`, password `user_credentials`, mobile refresh tokens) are
 * repointed onto the winner so every previous way of signing in still lands on
 * the merged account.
 *
 * Default mode is dry-run. Use --apply only after reading the candidate report,
 * and take a fresh pg_dump first — deleting users is irreversible.
 *
 * Usage:
 *   vp run db:merge-accounts
 *   vp run db:merge-accounts --only-email foo@x.com
 *   vp run db:merge-accounts --apply --limit 5
 */

import { sql, type SQLWrapper, type SQL } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import { createScriptDb } from './db-connection.js';
import { executeRows } from '../src/client/index.js';

const APPLY_FLAG = '--apply';
const LIMIT_FLAG = '--limit';
const ONLY_EMAIL_FLAG = '--only-email';
const HELP_FLAG = '--help';
const ARG_SEPARATOR = '--';

type ExecuteDb = {
  execute(query: SQLWrapper | string): PromiseLike<unknown>;
};

type ScriptArgs = {
  apply: boolean;
  limit: number | null;
  onlyEmail: string | null;
  help: boolean;
};

type MemberRow = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: string | null;
  createdAt: string;
  updatedAt: string;
  tickCount: number | string;
  favoriteCount: number | string;
  followCount: number | string;
  playlistCount: number | string;
  hasCredential: boolean;
};

type Member = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: string | null;
  createdAt: string;
  updatedAt: string;
  tickCount: number;
  favoriteCount: number;
  followCount: number;
  playlistCount: number;
  hasCredential: boolean;
};

type DuplicateSet = {
  lowerEmail: string;
  members: Member[];
  winner: Member;
  losers: Member[];
};

type CountRow = { count: number | string | null };

/**
 * Plain repoints: a user-referencing column NOT part of any user-scoped unique
 * constraint. We move every loser row onto the winner. `accounts`/`sessions`
 * use NextAuth's quoted camelCase `"userId"` column; everything else is
 * snake_case. SET NULL columns are included here so attribution (who created a
 * climb, who acted on a feed item) moves to the winner instead of being nulled
 * when the loser is deleted.
 */
const PLAIN_REPOINTS: Array<{ table: string; column: string }> = [
  { table: 'accounts', column: '"userId"' },
  { table: 'sessions', column: '"userId"' },
  { table: 'mobile_refresh_tokens', column: 'user_id' },
  { table: 'esp32_controllers', column: 'user_id' },
  { table: 'comments', column: 'user_id' },
  { table: 'app_feedback', column: 'user_id' },
  { table: 'board_climb_events', column: 'user_id' },
  { table: 'feed_items', column: 'recipient_id' },
  { table: 'feed_items', column: 'actor_id' },
  { table: 'notifications', column: 'recipient_id' },
  { table: 'notifications', column: 'actor_id' },
  { table: 'activity_push_tokens', column: 'user_id' },
  { table: 'board_sessions', column: 'created_by_user_id' },
  { table: 'community_settings', column: 'set_by' },
  { table: 'community_roles', column: 'granted_by' },
  { table: 'climb_proposals', column: 'proposer_id' },
  { table: 'climb_proposals', column: 'resolved_by' },
  { table: 'board_climbs', column: 'user_id' },
  // board_beta_links.created_by_user_id is a real users(id) FK (ON DELETE SET
  // NULL) declared only in migration 0093, not via .references() — repoint it so
  // the loser's beta-link attribution moves to the winner instead of nulling.
  { table: 'board_beta_links', column: 'created_by_user_id' },
  { table: 'gyms', column: 'owner_id' },
];

/**
 * Dedupe repoints: the user-referencing column participates in a user-scoped
 * unique constraint, so a loser row collides if the winner already holds the
 * same tuple. We move only the non-colliding loser rows; the colliding ones are
 * left behind and removed by the final `DELETE FROM users` cascade. Processing
 * one loser at a time means a 3-row set also dedupes against losers already
 * merged into the winner. `otherCols` are the rest of the unique constraint;
 * `IS NOT DISTINCT FROM` covers the nullable, NULLS-NOT-DISTINCT cases
 * (community_roles.board_type) and is equivalent to `=` for NOT NULL columns.
 */
const DEDUPE_REPOINTS: Array<{ table: string; column: string; otherCols: string[] }> = [
  { table: 'user_board_mappings', column: 'user_id', otherCols: ['board_type'] },
  { table: 'aurora_credentials', column: 'user_id', otherCols: ['board_type'] },
  { table: 'integration_credentials', column: 'user_id', otherCols: ['provider'] },
  { table: 'integration_exports', column: 'user_id', otherCols: ['provider', 'session_type', 'session_id'] },
  { table: 'user_favorites', column: 'user_id', otherCols: ['board_name', 'climb_uuid', 'angle'] },
  { table: 'setter_follows', column: 'follower_id', otherCols: ['setter_username'] },
  { table: 'playlist_follows', column: 'follower_id', otherCols: ['playlist_uuid'] },
  { table: 'board_follows', column: 'user_id', otherCols: ['board_uuid'] },
  { table: 'gym_members', column: 'user_id', otherCols: ['gym_id'] },
  { table: 'gym_follows', column: 'user_id', otherCols: ['gym_id'] },
  { table: 'playlist_ownership', column: 'user_id', otherCols: ['playlist_id'] },
  { table: 'user_playlist_pins', column: 'user_id', otherCols: ['playlist_id'] },
  { table: 'proposal_votes', column: 'user_id', otherCols: ['proposal_id'] },
  { table: 'community_roles', column: 'user_id', otherCols: ['role', 'board_type'] },
  { table: 'board_session_participants', column: 'user_id', otherCols: ['session_id'] },
  { table: 'session_health_kit_workouts', column: 'user_id', otherCols: ['session_id'] },
  {
    table: 'user_hold_classifications',
    column: 'user_id',
    otherCols: ['board_type', 'layout_id', 'size_id', 'hold_id'],
  },
  { table: 'new_climb_subscriptions', column: 'user_id', otherCols: ['board_type', 'layout_id'] },
  { table: 'user_board_serials', column: 'user_id', otherCols: ['serial_number'] },
  // user-scoped unique only — the aurora_id/kilter_id partial uniques are global,
  // so a given surrogate exists on at most one rating and can never collide here.
  { table: 'board_climb_ratings', column: 'user_id', otherCols: ['board_type', 'climb_uuid', 'angle'] },
];

// Columns repointed by the hand-coded specials in mergeLoserIntoWinner / mergeSet
// (not in the two arrays above). Listed here so the FK-completeness guard knows
// they're handled.
const SPECIAL_REPOINT_COLUMNS: Array<{ table: string; column: string }> = [
  { table: 'boardsesh_ticks', column: 'user_id' },
  { table: 'user_boards', column: 'owner_id' },
  { table: 'votes', column: 'user_id' },
  { table: 'user_follows', column: 'follower_id' },
  { table: 'user_follows', column: 'following_id' },
  { table: 'user_credentials', column: 'user_id' },
  { table: 'user_profiles', column: 'user_id' },
];

// FKs to users(id) we deliberately do NOT repoint: derived/ephemeral rows the
// loser owns that should just be cleaned up by the cascade on user delete.
const CASCADE_ONLY_COLUMNS: Array<{ table: string; column: string }> = [
  // Nightly-recomputed percentile snapshot keyed PK(user_id) — the loser's stale
  // row cascades away and the winner's is recomputed from the repointed ticks.
  { table: 'user_climb_percentiles', column: 'user_id' },
];

function parsePositiveInteger(rawValue: string | undefined, flagName: string): number {
  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    console.error(`[merge-accounts] ${flagName} requires a positive integer.`);
    process.exit(2);
  }
  return parsedValue;
}

function readRequiredOptionValue(args: string[], optionIndex: number, flagName: string): string {
  const optionValue = args[optionIndex + 1];
  if (!optionValue || optionValue.startsWith('--')) {
    console.error(`[merge-accounts] ${flagName} requires a value.`);
    process.exit(2);
  }
  return optionValue;
}

export function parseArgs(args: string[]): ScriptArgs {
  const parsedArgs: ScriptArgs = { apply: false, limit: null, onlyEmail: null, help: false };

  for (let index = 0; index < args.length; index++) {
    const currentArg = args[index];
    if (currentArg === ARG_SEPARATOR) {
      continue;
    }
    if (currentArg === APPLY_FLAG) {
      parsedArgs.apply = true;
      continue;
    }
    if (currentArg === HELP_FLAG) {
      parsedArgs.help = true;
      continue;
    }
    if (currentArg === LIMIT_FLAG) {
      parsedArgs.limit = parsePositiveInteger(readRequiredOptionValue(args, index, LIMIT_FLAG), LIMIT_FLAG);
      index += 1;
      continue;
    }
    if (currentArg === ONLY_EMAIL_FLAG) {
      parsedArgs.onlyEmail = readRequiredOptionValue(args, index, ONLY_EMAIL_FLAG).trim().toLowerCase();
      index += 1;
      continue;
    }

    console.error(`[merge-accounts] Unknown argument: ${currentArg}`);
    process.exit(2);
  }

  return parsedArgs;
}

function printHelp(): void {
  console.info(`Usage:
  vp run db:merge-accounts                       Dry-run report of every duplicate-by-case set.
  vp run db:merge-accounts --only-email a@b.com  Restrict to one lower-cased email.
  vp run db:merge-accounts --apply --limit 5     Merge (up to 5 sets). Take a pg_dump first.

Options:
  --apply               Perform the merge. Omit for a dry-run report.
  --limit <n>           Limit the number of duplicate sets processed.
  --only-email <email>  Restrict to a single lower-cased email.
  --help                Show this help text.`);
}

function coerceMember(row: MemberRow): Member {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    image: row.image,
    emailVerified: row.emailVerified,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tickCount: Number(row.tickCount),
    favoriteCount: Number(row.favoriteCount),
    followCount: Number(row.followCount),
    playlistCount: Number(row.playlistCount),
    hasCredential: row.hasCredential,
  };
}

function relatedCount(member: Member): number {
  return member.favoriteCount + member.followCount + member.playlistCount;
}

/**
 * Winner = most ticks, then most other owned rows, then a verified email, then
 * the oldest account (stable). Deterministic so dry-run and apply agree.
 */
function compareForWinner(first: Member, second: Member): number {
  if (first.tickCount !== second.tickCount) return second.tickCount - first.tickCount;
  if (relatedCount(first) !== relatedCount(second)) return relatedCount(second) - relatedCount(first);
  const firstVerified = first.emailVerified ? 1 : 0;
  const secondVerified = second.emailVerified ? 1 : 0;
  if (firstVerified !== secondVerified) return secondVerified - firstVerified;
  return first.createdAt.localeCompare(second.createdAt);
}

export function buildDuplicateSets(members: Member[]): DuplicateSet[] {
  const byEmail = new Map<string, Member[]>();
  for (const member of members) {
    const key = member.email.trim().toLowerCase();
    const bucket = byEmail.get(key);
    if (bucket) {
      bucket.push(member);
    } else {
      byEmail.set(key, [member]);
    }
  }

  const sets: DuplicateSet[] = [];
  for (const [lowerEmail, bucket] of byEmail) {
    if (bucket.length < 2) continue;
    const ordered = [...bucket].sort(compareForWinner);
    const [winner, ...losers] = ordered;
    sets.push({ lowerEmail, members: ordered, winner, losers });
  }
  // Stable output order — by email so the report and apply iterate identically.
  sets.sort((first, second) => first.lowerEmail.localeCompare(second.lowerEmail));
  return sets;
}

const MEMBER_COLUMNS = sql`
  u.id AS "id",
  u.email AS "email",
  u.name AS "name",
  u.image AS "image",
  u."emailVerified"::text AS "emailVerified",
  u.created_at::text AS "createdAt",
  u.updated_at::text AS "updatedAt",
  COALESCE(tick_counts.count, 0)::int AS "tickCount",
  COALESCE(favorite_counts.count, 0)::int AS "favoriteCount",
  COALESCE(follow_counts.count, 0)::int AS "followCount",
  COALESCE(playlist_counts.count, 0)::int AS "playlistCount",
  (credentials.user_id IS NOT NULL) AS "hasCredential"
`;

const MEMBER_JOINS = sql`
  LEFT JOIN (SELECT user_id, count(*) AS count FROM boardsesh_ticks GROUP BY user_id) tick_counts
    ON tick_counts.user_id = u.id
  LEFT JOIN (SELECT user_id, count(*) AS count FROM user_favorites GROUP BY user_id) favorite_counts
    ON favorite_counts.user_id = u.id
  LEFT JOIN (SELECT follower_id AS user_id, count(*) AS count FROM user_follows GROUP BY follower_id) follow_counts
    ON follow_counts.user_id = u.id
  LEFT JOIN (SELECT user_id, count(*) AS count FROM playlist_ownership GROUP BY user_id) playlist_counts
    ON playlist_counts.user_id = u.id
  LEFT JOIN user_credentials credentials ON credentials.user_id = u.id
`;

async function fetchAllDuplicateMembers(commandDb: ExecuteDb, onlyEmail: string | null): Promise<Member[]> {
  const emailClause = onlyEmail
    ? sql`lower(u.email) = ${onlyEmail}`
    : sql`lower(u.email) IN (SELECT lower(email) FROM users GROUP BY lower(email) HAVING count(*) > 1)`;

  const rows = await executeRows<MemberRow>(
    commandDb,
    sql`SELECT ${MEMBER_COLUMNS} FROM users u ${MEMBER_JOINS} WHERE ${emailClause} ORDER BY lower(u.email), u.created_at`,
  );
  return rows.map(coerceMember);
}

export async function fetchMembersForEmail(commandDb: ExecuteDb, lowerEmail: string): Promise<Member[]> {
  const rows = await executeRows<MemberRow>(
    commandDb,
    sql`SELECT ${MEMBER_COLUMNS} FROM users u ${MEMBER_JOINS} WHERE lower(u.email) = ${lowerEmail} ORDER BY u.created_at`,
  );
  return rows.map(coerceMember);
}

function memberIdKey(members: Member[]): string {
  return members
    .map((member) => member.id)
    .sort()
    .join(',');
}

function sqlIdList(ids: string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

function anomalyFlags(duplicateSet: DuplicateSet): string[] {
  const flags: string[] = [];
  if (duplicateSet.members.length > 2) flags.push(`${duplicateSet.members.length}-row set`);
  if (duplicateSet.losers.some((loser) => loser.tickCount > 0) && duplicateSet.winner.tickCount > 0) {
    flags.push('multiple accounts have ticks');
  }
  if (duplicateSet.members.filter((member) => member.hasCredential).length > 1) {
    flags.push('multiple accounts have passwords');
  }
  return flags;
}

function formatMemberLabel(member: Member, isWinner: boolean): string {
  const role = isWinner ? 'winner   ' : 'loser    ';
  const verified = member.emailVerified ? 'verified' : 'unverified';
  return (
    `  ${role} ${member.email} (#${member.id}, ${member.createdAt.slice(0, 10)}, ${verified}` +
    `${member.hasCredential ? ', password' : ''})\n` +
    `    ticks=${member.tickCount}, favorites=${member.favoriteCount}, follows=${member.followCount}, playlists=${member.playlistCount}`
  );
}

function printReport(sets: DuplicateSet[], apply: boolean): void {
  const loserCount = sets.reduce((total, duplicateSet) => total + duplicateSet.losers.length, 0);
  console.info(
    `[merge-accounts] Found ${sets.length} duplicate-by-case set(s), ${loserCount} account(s) to merge away.`,
  );

  for (const [index, duplicateSet] of sets.entries()) {
    const flags = anomalyFlags(duplicateSet);
    console.info('');
    console.info(
      `[merge-accounts] ${index + 1}. ${duplicateSet.lowerEmail}${flags.length ? `  ⚠ ${flags.join('; ')}` : ''}`,
    );
    console.info(formatMemberLabel(duplicateSet.winner, true));
    for (const loser of duplicateSet.losers) {
      console.info(formatMemberLabel(loser, false));
    }
  }

  if (!apply) {
    console.info('');
    console.info('[merge-accounts] Dry-run only. Re-run with --apply to merge (take a pg_dump first).');
  }
}

async function execute(commandDb: ExecuteDb, query: SQL): Promise<void> {
  await commandDb.execute(query);
}

async function executeCount(commandDb: ExecuteDb, query: SQL): Promise<number> {
  const [row] = await executeRows<CountRow>(commandDb, query);
  return Number(row?.count ?? 0);
}

/** Move every row a single loser owns onto the winner, deduping where needed. */
async function mergeLoserIntoWinner(commandDb: ExecuteDb, winnerId: string, loserId: string): Promise<void> {
  for (const { table, column } of PLAIN_REPOINTS) {
    await execute(
      commandDb,
      sql`UPDATE ${sql.raw(table)} SET ${sql.raw(column)} = ${winnerId} WHERE ${sql.raw(column)} = ${loserId}`,
    );
  }

  for (const { table, column, otherCols } of DEDUPE_REPOINTS) {
    const matchClause = sql.join(
      otherCols.map((otherCol) => sql.raw(`winner_row.${otherCol} IS NOT DISTINCT FROM target.${otherCol}`)),
      sql` AND `,
    );
    await execute(
      commandDb,
      sql`
        UPDATE ${sql.raw(table)} AS target
           SET ${sql.raw(column)} = ${winnerId}
         WHERE target.${sql.raw(column)} = ${loserId}
           AND NOT EXISTS (
             SELECT 1 FROM ${sql.raw(table)} AS winner_row
              WHERE winner_row.${sql.raw(column)} = ${winnerId}
                AND ${matchClause}
           )
      `,
    );
  }

  // boardsesh_ticks: aurora_id/kilter_id are globally unique, so a loser tick
  // can never share one with a winner tick under the current schema — this
  // moves all of them. The surrogate guards are defensive: if the unique is
  // ever scoped per-user, true duplicates stay behind and cascade away.
  await execute(
    commandDb,
    sql`
      UPDATE boardsesh_ticks AS target
         SET user_id = ${winnerId}
       WHERE target.user_id = ${loserId}
         AND NOT EXISTS (
           SELECT 1 FROM boardsesh_ticks AS winner_row
            WHERE winner_row.user_id = ${winnerId}
              AND winner_row.aurora_id IS NOT NULL
              AND winner_row.aurora_id = target.aurora_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM boardsesh_ticks AS winner_row
            WHERE winner_row.user_id = ${winnerId}
              AND winner_row.kilter_id IS NOT NULL
              AND winner_row.kilter_id = target.kilter_id
         )
    `,
  );

  // user_boards: partial uniques on (owner, board config) and (owner, serial),
  // both only over active (deleted_at IS NULL) non-system rows. Move a loser
  // board unless an active winner board already occupies the same config or
  // serial; colliding loser boards cascade away with the loser.
  await execute(
    commandDb,
    sql`
      UPDATE user_boards AS target
         SET owner_id = ${winnerId}, updated_at = NOW()
       WHERE target.owner_id = ${loserId}
         AND NOT EXISTS (
           SELECT 1 FROM user_boards AS winner_row
            WHERE winner_row.owner_id = ${winnerId}
              AND winner_row.deleted_at IS NULL
              AND target.deleted_at IS NULL
              AND winner_row.board_type = target.board_type
              AND winner_row.layout_id = target.layout_id
              AND winner_row.size_id = target.size_id
              AND winner_row.set_ids = target.set_ids
         )
         AND NOT EXISTS (
           SELECT 1 FROM user_boards AS winner_row
            WHERE winner_row.owner_id = ${winnerId}
              AND winner_row.deleted_at IS NULL
              AND target.deleted_at IS NULL
              AND target.serial_number IS NOT NULL
              AND target.serial_number <> ''
              AND winner_row.serial_number = target.serial_number
         )
    `,
  );

  // votes: user-scoped unique on (user_id, entity_type, entity_id). Move the
  // loser's votes onto the winner where the winner hasn't already voted; the
  // dropped duplicates are reconciled in vote_counts after the merge.
  await execute(
    commandDb,
    sql`
      UPDATE votes AS target
         SET user_id = ${winnerId}
       WHERE target.user_id = ${loserId}
         AND NOT EXISTS (
           SELECT 1 FROM votes AS winner_row
            WHERE winner_row.user_id = ${winnerId}
              AND winner_row.entity_type = target.entity_type
              AND winner_row.entity_id = target.entity_id
         )
    `,
  );

  // user_credentials / user_profiles are PK(user_id): adopt the loser's row
  // only when the winner has none. user_profiles also back-fills the winner's
  // null fields from the loser before the (no-op-if-present) adopt.
  await execute(
    commandDb,
    sql`
      UPDATE user_profiles AS winner_profile
         SET display_name = COALESCE(winner_profile.display_name, loser_profile.display_name),
             avatar_url = COALESCE(winner_profile.avatar_url, loser_profile.avatar_url),
             instagram_url = COALESCE(winner_profile.instagram_url, loser_profile.instagram_url),
             updated_at = NOW()
        FROM user_profiles AS loser_profile
       WHERE winner_profile.user_id = ${winnerId}
         AND loser_profile.user_id = ${loserId}
    `,
  );
  await execute(
    commandDb,
    sql`
      UPDATE user_profiles
         SET user_id = ${winnerId}
       WHERE user_id = ${loserId}
         AND NOT EXISTS (SELECT 1 FROM user_profiles AS winner_row WHERE winner_row.user_id = ${winnerId})
    `,
  );
  await execute(
    commandDb,
    sql`
      UPDATE user_credentials
         SET user_id = ${winnerId}
       WHERE user_id = ${loserId}
         AND NOT EXISTS (SELECT 1 FROM user_credentials AS winner_row WHERE winner_row.user_id = ${winnerId})
    `,
  );
}

/** Apply the winner's reconciled name / image / emailVerified to the users row. */
async function reconcileWinnerFields(commandDb: ExecuteDb, duplicateSet: DuplicateSet): Promise<void> {
  const { winner, members } = duplicateSet;

  const byRecentUpdate = [...members].sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
  const name = winner.name ?? byRecentUpdate.find((member) => member.name)?.name ?? null;
  const image = winner.image ?? byRecentUpdate.find((member) => member.image)?.image ?? null;
  const verifiedTimestamps = members
    .map((member) => member.emailVerified)
    .filter((value): value is string => value !== null)
    .sort();
  const emailVerified = verifiedTimestamps[0] ?? null;

  await execute(
    commandDb,
    sql`
      UPDATE users
         SET name = ${name},
             image = ${image},
             "emailVerified" = ${emailVerified},
             updated_at = NOW()
       WHERE id = ${winner.id}
    `,
  );
}

async function mergeSet(commandDb: ExecuteDb, duplicateSet: DuplicateSet): Promise<void> {
  const winnerId = duplicateSet.winner.id;
  const loserIds = duplicateSet.losers.map((loser) => loser.id);
  const allIds = duplicateSet.members.map((member) => member.id);

  // Remove every follow edge whose endpoints are both inside the set, so no
  // repoint can produce a (winner, winner) self-follow.
  await execute(
    commandDb,
    sql`
      DELETE FROM user_follows
       WHERE follower_id IN (${sqlIdList(allIds)})
         AND following_id IN (${sqlIdList(allIds)})
    `,
  );

  for (const loserId of loserIds) {
    await mergeLoserIntoWinner(commandDb, winnerId, loserId);

    // user_follows is symmetric: repoint both sides, deduping against edges the
    // winner already has. Intra-set edges were deleted above, so neither side
    // can create a self-follow.
    await execute(
      commandDb,
      sql`
        UPDATE user_follows AS target
           SET follower_id = ${winnerId}
         WHERE target.follower_id = ${loserId}
           AND NOT EXISTS (
             SELECT 1 FROM user_follows AS winner_row
              WHERE winner_row.follower_id = ${winnerId}
                AND winner_row.following_id = target.following_id
           )
      `,
    );
    await execute(
      commandDb,
      sql`
        UPDATE user_follows AS target
           SET following_id = ${winnerId}
         WHERE target.following_id = ${loserId}
           AND NOT EXISTS (
             SELECT 1 FROM user_follows AS winner_row
              WHERE winner_row.following_id = ${winnerId}
                AND winner_row.follower_id = target.follower_id
           )
      `,
    );
  }

  await reconcileWinnerFields(commandDb, duplicateSet);

  // Delete losers last: FK cascades clear anything left behind (rows we
  // intentionally dropped because the winner already had an equivalent one,
  // plus derived tables like user_climb_percentiles). The votes_count_trigger
  // (AFTER INSERT/UPDATE/DELETE on votes) keeps vote_counts correct as the
  // repointed and cascade-deleted vote rows change — it recounts each affected
  // entity idempotently, so no manual vote_counts maintenance is needed here.
  await execute(commandDb, sql`DELETE FROM users WHERE id IN (${sqlIdList(loserIds)})`);
}

export async function applyMerge(
  commandDb: ExecuteDb,
  duplicateSet: DuplicateSet,
): Promise<{ merged: boolean; reason?: string }> {
  // Lock the set's user rows and re-derive membership inside the transaction so
  // a concurrent signup/merge can't change the set out from under us.
  await commandDb.execute(sql`SELECT id FROM users WHERE lower(email) = ${duplicateSet.lowerEmail} FOR UPDATE`);
  const lockedMembers = await fetchMembersForEmail(commandDb, duplicateSet.lowerEmail);

  if (lockedMembers.length < 2) {
    return { merged: false, reason: 'no longer a duplicate set' };
  }
  if (memberIdKey(lockedMembers) !== memberIdKey(duplicateSet.members)) {
    return { merged: false, reason: 'set membership changed since the dry-run' };
  }

  const lockedSet = buildDuplicateSets(lockedMembers)[0];
  await mergeSet(commandDb, lockedSet);
  return { merged: true };
}

type ForeignKeyRow = { childTable: string; childColumn: string };

/**
 * Fail loudly before touching any data if a foreign key to users(id) exists that
 * the script doesn't know how to handle. The repoint lists are hand-maintained;
 * if a later migration adds a new user_id FK, a silent skip would either block
 * the loser DELETE (RESTRICT) or cascade-delete / null data the operator
 * expected to be moved. This diffs the actual FK set in pg_catalog against the
 * union of the repoint lists, the specials, and the deliberate cascade-only
 * allow-list — and aborts with the offending columns if anything is unaccounted.
 */
export async function assertAllUserFksHandled(commandDb: ExecuteDb): Promise<void> {
  const handled = new Set<string>(
    [...PLAIN_REPOINTS, ...DEDUPE_REPOINTS, ...SPECIAL_REPOINT_COLUMNS, ...CASCADE_ONLY_COLUMNS].map(
      // strip NextAuth's quoted "userId" so it matches pg_catalog's attname
      ({ table, column }) => `${table}.${column.replace(/"/g, '')}`,
    ),
  );

  const actualForeignKeys = await executeRows<ForeignKeyRow>(
    commandDb,
    sql`
      SELECT child.relname AS "childTable", child_attr.attname AS "childColumn"
        FROM pg_constraint constraint_row
        JOIN pg_class child ON child.oid = constraint_row.conrelid
        JOIN pg_class parent ON parent.oid = constraint_row.confrelid
        JOIN pg_attribute child_attr
          ON child_attr.attrelid = constraint_row.conrelid
         AND child_attr.attnum = constraint_row.conkey[1]
        JOIN pg_attribute parent_attr
          ON parent_attr.attrelid = constraint_row.confrelid
         AND parent_attr.attnum = constraint_row.confkey[1]
       WHERE constraint_row.contype = 'f'
         AND parent.relname = 'users'
         AND parent.relnamespace = 'public'::regnamespace
         AND parent_attr.attname = 'id'
         AND array_length(constraint_row.conkey, 1) = 1
    `,
  );

  const unhandled = actualForeignKeys
    .map((foreignKey) => `${foreignKey.childTable}.${foreignKey.childColumn}`)
    .filter((key) => !handled.has(key))
    .sort();

  if (unhandled.length > 0) {
    throw new Error(
      `merge-accounts is out of date: ${unhandled.length} foreign key(s) to users(id) are not handled by the ` +
        `repoint lists — ${unhandled.join(', ')}. Add each to PLAIN_REPOINTS, DEDUPE_REPOINTS, the specials, or ` +
        `CASCADE_ONLY_COLUMNS before running a merge.`,
    );
  }
}

async function main(): Promise<void> {
  const scriptArgs = parseArgs(process.argv.slice(2));
  if (scriptArgs.help) {
    printHelp();
    return;
  }

  const { db, close } = createScriptDb();

  try {
    // Abort before any writes if the schema has grown a user FK we don't handle.
    await assertAllUserFksHandled(db);

    const members = await fetchAllDuplicateMembers(db, scriptArgs.onlyEmail);
    const allSets = buildDuplicateSets(members);
    const selectedSets = scriptArgs.limit ? allSets.slice(0, scriptArgs.limit) : allSets;

    printReport(selectedSets, scriptArgs.apply);

    if (!scriptArgs.apply || selectedSets.length === 0) {
      return;
    }

    let mergedCount = 0;
    let skippedCount = 0;
    for (const duplicateSet of selectedSets) {
      const result = await db.transaction(async (transaction) => {
        await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext('boardsesh:merge-accounts'))`);
        return applyMerge(transaction, duplicateSet);
      });

      if (result.merged) {
        mergedCount += 1;
        console.info(
          `[merge-accounts] merged ${duplicateSet.losers.length} account(s) into ${duplicateSet.winner.email} (#${duplicateSet.winner.id}).`,
        );
      } else {
        skippedCount += 1;
        console.warn(`[merge-accounts] skipped ${duplicateSet.lowerEmail}: ${result.reason}.`);
      }
    }

    const remaining = await executeCount(
      db,
      sql`
        WITH dupes AS (
          SELECT lower(email) FROM users GROUP BY lower(email) HAVING count(*) > 1
        )
        SELECT count(*)::int AS count FROM dupes
      `,
    );

    console.info('');
    console.info(
      `[merge-accounts] Done. Merged ${mergedCount} set(s), skipped ${skippedCount}. ${remaining} duplicate set(s) remain.`,
    );
  } finally {
    await close();
  }
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error('[merge-accounts] failed:', error);
    process.exit(1);
  });
}
