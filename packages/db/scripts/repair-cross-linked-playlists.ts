/**
 * Audit — and, with --apply, repair — playlists that carry `playlist_ownership`
 * rows for two different Boardsesh users (#3541).
 *
 * These exist because one Aurora account could once be linked to two Boardsesh
 * users, and both the JSON importer and the Aurora circuits sync keyed playlists
 * on the GLOBAL `playlists_aurora_id_idx`. All three source defects are fixed
 * (see the header of repair-cross-linked-playlists-helpers.ts), so this script
 * exists purely to clean up the rows that were written before the guards landed.
 *
 * SAFETY
 *   - Dry-run by default. --apply is the only mode that writes.
 *   - The only rows it ever deletes are `playlist_ownership`, `user_playlist_pins`
 *     and `playlist_follows` rows belonging to the LATER of the two owners.
 *     It never deletes a playlist, a playlist_climbs row, a tick, a credential,
 *     or a user.
 *   - Duplicate-account pairs (two accounts with case-variant emails) are
 *     reported but NOT touched: merge-accounts.ts (#3278) is the right tool for
 *     those, because it also moves the ticks and credentials this script leaves
 *     alone. --include-merge-candidates opts in anyway.
 *   - Anything the helpers can't attribute to a known defect is refused, printed,
 *     and left for a human.
 *   - The one row --apply ADDS is an append-only `sync_deletions` tombstone
 *     scoped to the adopter, so their offline clients drop the playlist they
 *     just lost access to. Without it the revoke is invisible on-device: the
 *     offline pull is gated on playlist_ownership and that table has no delete
 *     trigger, so the local copy would linger forever.
 *
 * Usage:
 *   vp run db:repair-cross-linked-playlists
 *   vp run db:repair-cross-linked-playlists --playlist-ids 12,34
 *   vp run db:repair-cross-linked-playlists --apply
 *   vp run db:repair-cross-linked-playlists --apply --include-merge-candidates
 *
 * (A `--` separator before the flags also works — `vp` forwards it to the script
 * verbatim and parseArgs skips it — but it isn't needed.)
 */
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { pathToFileURL } from 'node:url';
import { createScriptDb, describeDatabaseHost, getScriptDatabaseUrl } from './db-connection.js';
import { playlistClimbs, playlistOwnership, playlists, userPlaylistPins } from '../src/schema/app/playlists.js';
import { playlistFollows } from '../src/schema/app/follows.js';
import { syncDeletions } from '../src/schema/app/sync-deletions.js';
import { auroraCredentials, userBoardMappings } from '../src/schema/auth/mappings.js';
import { users } from '../src/schema/auth/users.js';
import {
  DEFAULT_MIN_OWNERSHIP_SPREAD_MINUTES,
  planCrossLinkedPlaylistRepairs,
  selectApplyablePlans,
  summarizeRepairPlans,
  type CrossLinkRepairPlan,
  type CrossLinkedPlaylist,
  type PlaylistOwnerRow,
} from './repair-cross-linked-playlists-helpers.js';

const LOG_TAG = '[repair-cross-linked-playlists]';

const APPLY_FLAG = '--apply';
const PLAYLIST_IDS_FLAG = '--playlist-ids';
const INCLUDE_MERGE_CANDIDATES_FLAG = '--include-merge-candidates';
const MIN_SPREAD_MINUTES_FLAG = '--min-spread-minutes';
const HELP_FLAG = '--help';
const ARG_SEPARATOR = '--';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type ScriptArgs = {
  apply: boolean;
  playlistIds: string[] | null;
  includeMergeCandidates: boolean;
  minSpreadMinutes: number;
  help: boolean;
};

/**
 * One board account (an Aurora numeric id, or a Kilter Keycloak subject) that
 * resolves to more than one Boardsesh user. Reported only — repairing these
 * means moving ticks and credentials, which is merge-accounts.ts's job (#3278).
 */
export type CrossLinkedBoardAccount = {
  source: 'aurora_credentials' | 'user_board_mappings';
  boardType: string;
  boardAccountKey: string;
  userIds: string[];
};

export type AdopterAttachments = {
  /** `user_playlist_pins` rows the adopter holds on the cross-linked playlist. */
  pinnedPlaylistIds: Set<string>;
  /** `playlist_follows` rows the adopter holds, keyed by playlist uuid. */
  followedPlaylistUuids: Set<string>;
};

export type AppliedRepairCounts = {
  ownershipRowsDeleted: number;
  pinsDeleted: number;
  followsDeleted: number;
  /** Append-only `sync_deletions` rows written so the adopter's offline clients drop the playlist. */
  tombstonesWritten: number;
  /** Playlist ids skipped because their ownership rows changed after the plan was built. */
  skippedByDrift: string[];
};

function readOptionValue(args: string[], optionIndex: number, flagName: string): { value: string; consumed: number } {
  const currentArg = args[optionIndex];
  const inlineSeparatorIndex = currentArg.indexOf('=');
  if (inlineSeparatorIndex !== -1) {
    return { value: currentArg.slice(inlineSeparatorIndex + 1), consumed: 0 };
  }
  const nextArg = args[optionIndex + 1];
  if (!nextArg || nextArg.startsWith('--')) {
    console.error(`${LOG_TAG} ${flagName} requires a value.`);
    process.exit(2);
  }
  return { value: nextArg, consumed: 1 };
}

function parsePlaylistIds(rawValue: string): string[] {
  const parsedIds = rawValue
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (parsedIds.length === 0) {
    console.error(`${LOG_TAG} ${PLAYLIST_IDS_FLAG} requires at least one id.`);
    process.exit(2);
  }
  for (const playlistId of parsedIds) {
    if (!/^\d+$/.test(playlistId)) {
      console.error(`${LOG_TAG} ${PLAYLIST_IDS_FLAG}: "${playlistId}" is not a playlist id.`);
      process.exit(2);
    }
  }
  return parsedIds;
}

function parseNonNegativeNumber(rawValue: string, flagName: string): number {
  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    console.error(`${LOG_TAG} ${flagName} requires a non-negative number of minutes.`);
    process.exit(2);
  }
  return parsedValue;
}

export function parseArgs(args: string[]): ScriptArgs {
  const parsedArgs: ScriptArgs = {
    apply: false,
    playlistIds: null,
    includeMergeCandidates: false,
    minSpreadMinutes: DEFAULT_MIN_OWNERSHIP_SPREAD_MINUTES,
    help: false,
  };

  for (let index = 0; index < args.length; index++) {
    const currentArg = args[index];
    const flagName = currentArg.split('=')[0];

    if (currentArg === ARG_SEPARATOR) {
      // `vp run db:repair-cross-linked-playlists -- --apply` forwards the
      // separator verbatim; tolerate it rather than rejecting it.
      continue;
    }
    if (currentArg === APPLY_FLAG) {
      parsedArgs.apply = true;
      continue;
    }
    if (currentArg === INCLUDE_MERGE_CANDIDATES_FLAG) {
      parsedArgs.includeMergeCandidates = true;
      continue;
    }
    if (currentArg === HELP_FLAG) {
      parsedArgs.help = true;
      continue;
    }
    if (flagName === PLAYLIST_IDS_FLAG) {
      const { value, consumed } = readOptionValue(args, index, PLAYLIST_IDS_FLAG);
      parsedArgs.playlistIds = parsePlaylistIds(value);
      index += consumed;
      continue;
    }
    if (flagName === MIN_SPREAD_MINUTES_FLAG) {
      const { value, consumed } = readOptionValue(args, index, MIN_SPREAD_MINUTES_FLAG);
      parsedArgs.minSpreadMinutes = parseNonNegativeNumber(value, MIN_SPREAD_MINUTES_FLAG);
      index += consumed;
      continue;
    }

    console.error(`${LOG_TAG} Unknown argument: ${currentArg}`);
    process.exit(2);
  }

  return parsedArgs;
}

function printHelp(): void {
  console.info(`Usage:
  vp run db:repair-cross-linked-playlists
  vp run db:repair-cross-linked-playlists --playlist-ids 12,34
  vp run db:repair-cross-linked-playlists --apply
  vp run db:repair-cross-linked-playlists --apply --include-merge-candidates

Options:
  --apply                       Delete the later owner's playlist_ownership row (plus that
                                user's pin/follow on the same playlist) and write an
                                adopter-scoped sync_deletions tombstone so their offline
                                clients drop the playlist too. Omit for dry-run.
  --playlist-ids <a,b,c>        Restrict the run to these playlists.id values.
  --include-merge-candidates    Also repair pairs whose two owners are the same email up to
                                case. Off by default — merge-accounts.ts (#3278) handles those
                                better because it moves their ticks and credentials too.
  --min-spread-minutes <n>      Refuse a pair whose two ownership rows are closer together
                                than this (default ${DEFAULT_MIN_OWNERSHIP_SPREAD_MINUTES}).
  --help                        Show this help text.

This script never deletes a playlist, a playlist_climbs row, a tick, a board
credential, or a user. The only row it ever adds is an append-only
sync_deletions tombstone.`);
}

/** playlists.id is a bigint column; the helpers carry it as a decimal string. */
function toPlaylistIdKey(playlistId: bigint | number | string): string {
  return String(playlistId);
}

export async function loadCrossLinkedPlaylists(
  commandDb: DrizzleDb,
  playlistIdFilter: string[] | null,
): Promise<CrossLinkedPlaylist[]> {
  const scopedPlaylistIds = playlistIdFilter?.map((playlistId) => BigInt(playlistId)) ?? null;
  if (scopedPlaylistIds !== null && scopedPlaylistIds.length === 0) {
    return [];
  }

  const multiOwnerRows = await commandDb
    .select({ playlistId: playlistOwnership.playlistId })
    .from(playlistOwnership)
    .where(scopedPlaylistIds ? inArray(playlistOwnership.playlistId, scopedPlaylistIds) : undefined)
    .groupBy(playlistOwnership.playlistId)
    .having(sql`count(distinct ${playlistOwnership.userId}) > 1`);

  const crossLinkedIds = multiOwnerRows.map((row) => row.playlistId);
  if (crossLinkedIds.length === 0) {
    return [];
  }

  const ownerRows = await commandDb
    .select({
      playlistId: playlists.id,
      playlistUuid: playlists.uuid,
      name: playlists.name,
      boardType: playlists.boardType,
      auroraId: playlists.auroraId,
      kilterId: playlists.kilterId,
      isPublic: playlists.isPublic,
      ownerUserId: playlistOwnership.userId,
      ownerEmail: users.email,
      ownerRole: playlistOwnership.role,
      ownerCreatedAt: playlistOwnership.createdAt,
    })
    .from(playlistOwnership)
    .innerJoin(playlists, eq(playlists.id, playlistOwnership.playlistId))
    .leftJoin(users, eq(users.id, playlistOwnership.userId))
    .where(inArray(playlistOwnership.playlistId, crossLinkedIds))
    .orderBy(playlistOwnership.playlistId, playlistOwnership.createdAt);

  const climbCountRows = await commandDb
    .select({ playlistId: playlistClimbs.playlistId, climbCount: sql<number>`count(*)::int` })
    .from(playlistClimbs)
    .where(inArray(playlistClimbs.playlistId, crossLinkedIds))
    .groupBy(playlistClimbs.playlistId);

  const climbCountByPlaylistId = new Map(
    climbCountRows.map((row) => [toPlaylistIdKey(row.playlistId), Number(row.climbCount)]),
  );

  const crossLinkedByPlaylistId = new Map<string, CrossLinkedPlaylist>();
  for (const row of ownerRows) {
    const playlistIdKey = toPlaylistIdKey(row.playlistId);
    let crossLinked = crossLinkedByPlaylistId.get(playlistIdKey);
    if (!crossLinked) {
      crossLinked = {
        playlistId: playlistIdKey,
        playlistUuid: row.playlistUuid,
        name: row.name,
        boardType: row.boardType,
        auroraId: row.auroraId,
        kilterId: row.kilterId,
        isPublic: row.isPublic,
        climbCount: climbCountByPlaylistId.get(playlistIdKey) ?? 0,
        owners: [],
      };
      crossLinkedByPlaylistId.set(playlistIdKey, crossLinked);
    }
    crossLinked.owners.push({
      userId: row.ownerUserId,
      userEmail: row.ownerEmail,
      role: row.ownerRole,
      createdAt: new Date(row.ownerCreatedAt),
    });
  }

  return [...crossLinkedByPlaylistId.values()];
}

/**
 * The pins and follows the LATER owner holds on the cross-linked playlists.
 * These ride along with the revoked ownership row: leaving them behind would
 * keep the playlist on the adopter's Pinned grid with no way to open it.
 */
export async function loadAdopterAttachments(
  commandDb: DrizzleDb,
  plans: CrossLinkRepairPlan[],
): Promise<AdopterAttachments> {
  const adopterPlans = plans.filter((plan): plan is CrossLinkRepairPlan & { adopter: PlaylistOwnerRow } =>
    Boolean(plan.adopter),
  );
  if (adopterPlans.length === 0) {
    return { pinnedPlaylistIds: new Set(), followedPlaylistUuids: new Set() };
  }

  const playlistIds = adopterPlans.map((plan) => BigInt(plan.playlist.playlistId));
  const playlistUuids = adopterPlans.map((plan) => plan.playlist.playlistUuid);
  const adopterUserIds = [...new Set(adopterPlans.map((plan) => plan.adopter.userId))];

  const pinRows = await commandDb
    .select({ playlistId: userPlaylistPins.playlistId, userId: userPlaylistPins.userId })
    .from(userPlaylistPins)
    .where(and(inArray(userPlaylistPins.playlistId, playlistIds), inArray(userPlaylistPins.userId, adopterUserIds)));

  const followRows = await commandDb
    .select({ playlistUuid: playlistFollows.playlistUuid, followerId: playlistFollows.followerId })
    .from(playlistFollows)
    .where(
      and(inArray(playlistFollows.playlistUuid, playlistUuids), inArray(playlistFollows.followerId, adopterUserIds)),
    );

  const adopterUserIdByPlaylistId = new Map(
    adopterPlans.map((plan) => [plan.playlist.playlistId, plan.adopter.userId]),
  );
  const adopterUserIdByPlaylistUuid = new Map(
    adopterPlans.map((plan) => [plan.playlist.playlistUuid, plan.adopter.userId]),
  );

  return {
    pinnedPlaylistIds: new Set(
      pinRows
        .filter((row) => adopterUserIdByPlaylistId.get(toPlaylistIdKey(row.playlistId)) === row.userId)
        .map((row) => toPlaylistIdKey(row.playlistId)),
    ),
    followedPlaylistUuids: new Set(
      followRows
        .filter((row) => adopterUserIdByPlaylistUuid.get(row.playlistUuid) === row.followerId)
        .map((row) => row.playlistUuid),
    ),
  };
}

/**
 * Board accounts (Aurora numeric ids and Kilter subject strings) that resolve to
 * more than one Boardsesh user. This is the upstream cause of the circuits-side
 * cross-links, and repairing it means moving ticks and credentials — out of
 * scope here, so it is audited and handed to merge-accounts.ts (#3278).
 */
export async function loadCrossLinkedBoardAccounts(commandDb: DrizzleDb): Promise<CrossLinkedBoardAccount[]> {
  const credentialRows = await commandDb
    .select({
      boardType: auroraCredentials.boardType,
      boardAccountKey: sql<string>`${auroraCredentials.auroraUserId}::text`,
      userIds: sql<string[]>`array_agg(distinct ${auroraCredentials.userId})`,
    })
    .from(auroraCredentials)
    .where(isNotNull(auroraCredentials.auroraUserId))
    .groupBy(auroraCredentials.boardType, auroraCredentials.auroraUserId)
    .having(sql`count(distinct ${auroraCredentials.userId}) > 1`);

  const mappingAccountKey = sql<string>`coalesce(${userBoardMappings.boardUserIdText}, ${userBoardMappings.boardUserId}::text)`;
  const mappingRows = await commandDb
    .select({
      boardType: userBoardMappings.boardType,
      boardAccountKey: mappingAccountKey,
      userIds: sql<string[]>`array_agg(distinct ${userBoardMappings.userId})`,
    })
    .from(userBoardMappings)
    .where(or(isNotNull(userBoardMappings.boardUserId), isNotNull(userBoardMappings.boardUserIdText)))
    .groupBy(userBoardMappings.boardType, mappingAccountKey)
    .having(sql`count(distinct ${userBoardMappings.userId}) > 1`);

  return [
    ...credentialRows.map((row) => ({
      source: 'aurora_credentials' as const,
      boardType: row.boardType,
      boardAccountKey: row.boardAccountKey,
      userIds: [...row.userIds].sort(),
    })),
    ...mappingRows.map((row) => ({
      source: 'user_board_mappings' as const,
      boardType: row.boardType,
      boardAccountKey: row.boardAccountKey,
      userIds: [...row.userIds].sort(),
    })),
  ];
}

async function loadEmailsByUserId(commandDb: DrizzleDb, userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) {
    return new Map();
  }
  const userRows = await commandDb
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, userIds));
  return new Map(userRows.map((row) => [row.id, row.email]));
}

function describeOwner(owner: PlaylistOwnerRow): string {
  return `${owner.userEmail ?? '(no email)'} [${owner.userId}] role=${owner.role} at ${owner.createdAt.toISOString()}`;
}

/**
 * What --apply would touch, counted from the plans it is actually allowed to
 * write. The dry-run prints this so the totals can be checked against a
 * pg_dump (or against the by-hand sample above) before anyone writes.
 */
export function countPlannedDeletions(
  applyablePlans: CrossLinkRepairPlan[],
  attachments: AdopterAttachments,
): { ownershipRows: number; pins: number; follows: number } {
  return {
    ownershipRows: applyablePlans.length,
    pins: applyablePlans.filter((plan) => attachments.pinnedPlaylistIds.has(plan.playlist.playlistId)).length,
    follows: applyablePlans.filter((plan) => attachments.followedPlaylistUuids.has(plan.playlist.playlistUuid)).length,
  };
}

function printRepairReport(
  plans: CrossLinkRepairPlan[],
  applyablePlans: CrossLinkRepairPlan[],
  attachments: AdopterAttachments,
  scriptArgs: ScriptArgs,
): void {
  const summary = summarizeRepairPlans(plans);
  console.info(
    `${LOG_TAG} ${summary.playlists} cross-linked playlist(s), ${summary.ownershipRows} ownership row(s): ` +
      `${summary.revokeAdopter} repairable, ${summary.deferToAccountMerge} deferred to merge-accounts.ts (#3278), ` +
      `${summary.refused} refused.`,
  );

  for (const [planIndex, plan] of plans.entries()) {
    const { playlist } = plan;
    console.info('');
    console.info(
      `${LOG_TAG} ${planIndex + 1}. playlist #${playlist.playlistId} "${playlist.name}" (${playlist.boardType}, ${playlist.playlistUuid})`,
    );
    console.info(
      `  action=${plan.action} cause=${plan.cause} climbs=${playlist.climbCount} public=${playlist.isPublic} ` +
        `aurora_id=${playlist.auroraId ?? '(null)'} kilter_id=${playlist.kilterId ?? '(null)'}`,
    );
    if (plan.creator) {
      console.info(`  creator: ${describeOwner(plan.creator)}`);
    }
    if (plan.adopter) {
      const pinned = attachments.pinnedPlaylistIds.has(playlist.playlistId) ? ' (holds a pin)' : '';
      const followed = attachments.followedPlaylistUuids.has(playlist.playlistUuid) ? ' (holds a follow)' : '';
      console.info(`  adopter: ${describeOwner(plan.adopter)}${pinned}${followed}`);
    }
    if (plan.spreadMinutes !== null) {
      console.info(`  spread: ${plan.spreadMinutes.toFixed(1)} min`);
    }
    console.info(`  reason: ${plan.reason}`);
  }

  const plannedDeletions = countPlannedDeletions(applyablePlans, attachments);
  const deferredButExcluded = scriptArgs.includeMergeCandidates
    ? 0
    : plans.filter((plan) => plan.action === 'defer-to-account-merge').length;

  console.info('');
  console.info(
    `${LOG_TAG} ${scriptArgs.apply ? 'Applying to' : 'A --apply run would touch'} ${applyablePlans.length} playlist(s): ` +
      `${plannedDeletions.ownershipRows} ownership row(s), ${plannedDeletions.pins} pin(s), ` +
      `${plannedDeletions.follows} follow(s) deleted, plus ${applyablePlans.length} adopter-scoped ` +
      `sync_deletions tombstone(s) so their offline clients drop the playlist. ` +
      `${summarizeRepairPlans(plans).refused} refused playlist(s) are reported only and never written.`,
  );
  if (deferredButExcluded > 0) {
    console.info(
      `${LOG_TAG} ${deferredButExcluded} duplicate-account playlist(s) are excluded — pass ` +
        `${INCLUDE_MERGE_CANDIDATES_FLAG} to include them, or merge the accounts with merge-accounts.ts (#3278).`,
    );
  }
  if (!scriptArgs.apply) {
    console.info(`${LOG_TAG} Dry-run only. Nothing was written. Take a pg_dump before re-running with ${APPLY_FLAG}.`);
  }
}

function printBoardAccountReport(boardAccounts: CrossLinkedBoardAccount[], emailsByUserId: Map<string, string>): void {
  console.info('');
  if (boardAccounts.length === 0) {
    console.info(`${LOG_TAG} No board account is linked to more than one Boardsesh user.`);
    return;
  }

  console.info(
    `${LOG_TAG} ${boardAccounts.length} board account(s) linked to more than one Boardsesh user. ` +
      `This script will NOT touch credentials, mappings, or ticks — use merge-accounts.ts (#3278) ` +
      `or unlink the duplicate by hand.`,
  );
  for (const boardAccount of boardAccounts) {
    const describedUsers = boardAccount.userIds
      .map((userId) => `${emailsByUserId.get(userId) ?? '(no email)'} [${userId}]`)
      .join(', ');
    console.info(
      `  ${boardAccount.source} ${boardAccount.boardType} account ${boardAccount.boardAccountKey} -> ${describedUsers}`,
    );
  }
}

/**
 * Delete the adopter's ownership row (and their pin/follow on the same playlist)
 * for every plan handed in, then tombstone the playlist for that adopter so
 * their offline clients drop it. Must run inside a transaction — the caller owns
 * the transaction so the integration test can roll the whole thing back.
 *
 * Re-reads and locks each playlist's ownership rows first: if they no longer
 * match the plan (a concurrent sync, a manual fix, a second run), the playlist is
 * skipped rather than repaired against stale facts.
 */
export async function applyRepairPlans(
  transaction: DrizzleDb,
  plans: CrossLinkRepairPlan[],
): Promise<AppliedRepairCounts> {
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext('boardsesh:cross-linked-playlist-repair'))`);

  const counts: AppliedRepairCounts = {
    ownershipRowsDeleted: 0,
    pinsDeleted: 0,
    followsDeleted: 0,
    tombstonesWritten: 0,
    skippedByDrift: [],
  };

  for (const plan of plans) {
    const { adopter } = plan;
    if (!adopter) {
      counts.skippedByDrift.push(plan.playlist.playlistId);
      continue;
    }

    const playlistId = BigInt(plan.playlist.playlistId);
    const lockedOwners = await transaction
      .select({
        userId: playlistOwnership.userId,
        role: playlistOwnership.role,
        createdAt: playlistOwnership.createdAt,
      })
      .from(playlistOwnership)
      .where(eq(playlistOwnership.playlistId, playlistId))
      .for('update');

    const plannedUserIds = plan.playlist.owners.map((owner) => owner.userId).sort();
    const lockedUserIds = lockedOwners.map((owner) => owner.userId).sort();
    const latestLockedOwner = [...lockedOwners].sort(
      (first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime(),
    )[0];

    const stillMatchesPlan =
      lockedUserIds.length === plannedUserIds.length &&
      lockedUserIds.every((userId, index) => userId === plannedUserIds[index]) &&
      latestLockedOwner?.userId === adopter.userId;

    if (!stillMatchesPlan) {
      console.warn(
        `${LOG_TAG} playlist #${plan.playlist.playlistId}: ownership changed since the plan was built — skipping.`,
      );
      counts.skippedByDrift.push(plan.playlist.playlistId);
      continue;
    }

    const deletedOwnership = await transaction
      .delete(playlistOwnership)
      .where(and(eq(playlistOwnership.playlistId, playlistId), eq(playlistOwnership.userId, adopter.userId)))
      .returning({ id: playlistOwnership.id });
    counts.ownershipRowsDeleted += deletedOwnership.length;

    const deletedPins = await transaction
      .delete(userPlaylistPins)
      .where(and(eq(userPlaylistPins.playlistId, playlistId), eq(userPlaylistPins.userId, adopter.userId)))
      .returning({ id: userPlaylistPins.id });
    counts.pinsDeleted += deletedPins.length;

    const deletedFollows = await transaction
      .delete(playlistFollows)
      .where(
        and(
          eq(playlistFollows.playlistUuid, plan.playlist.playlistUuid),
          eq(playlistFollows.followerId, adopter.userId),
        ),
      )
      .returning({ id: playlistFollows.id });
    counts.followsDeleted += deletedFollows.length;

    // The offline pull joins playlist_ownership (syncPlaylists /
    // syncPlaylistClimbs), and playlist_ownership carries no delete trigger, so
    // revoking the row alone just makes the playlist stop arriving — the
    // adopter's local SQLite copy and its playlist_climbs rows would survive
    // forever. This adopter-scoped tombstone is what removes them; pull-client
    // cascades the local climbs off a `playlists` tombstone, matching 0144's
    // "no child tombstones for a whole-playlist delete" rule. The creator's
    // devices never see it. Append-only: it deletes nothing.
    if (deletedOwnership.length > 0) {
      await transaction.insert(syncDeletions).values({
        tableName: 'playlists',
        recordId: plan.playlist.playlistUuid,
        userId: adopter.userId,
      });
      counts.tombstonesWritten += 1;
    }
  }

  return counts;
}

async function main(): Promise<void> {
  const scriptArgs = parseArgs(process.argv.slice(2));
  if (scriptArgs.help) {
    printHelp();
    return;
  }

  // Name the target before doing anything: db-connection.ts loads .env.local,
  // which in this repo can hold a real production credential, so "which
  // database am I about to write to" must not be something the operator has to
  // infer from their shell history.
  console.info(
    `${LOG_TAG} ${scriptArgs.apply ? 'WRITE MODE (--apply)' : 'Read-only audit (dry-run)'} against ${describeDatabaseHost(getScriptDatabaseUrl())}`,
  );

  const { db, close } = createScriptDb();

  try {
    const crossLinkedPlaylists = await loadCrossLinkedPlaylists(db, scriptArgs.playlistIds);
    const plans = planCrossLinkedPlaylistRepairs(crossLinkedPlaylists, {
      minSpreadMinutes: scriptArgs.minSpreadMinutes,
    });
    const attachments = await loadAdopterAttachments(db, plans);
    const applyablePlans = selectApplyablePlans(plans, {
      includeMergeCandidates: scriptArgs.includeMergeCandidates,
    });
    printRepairReport(plans, applyablePlans, attachments, scriptArgs);

    const boardAccounts = await loadCrossLinkedBoardAccounts(db);
    const boardAccountUserIds = [...new Set(boardAccounts.flatMap((boardAccount) => boardAccount.userIds))];
    printBoardAccountReport(boardAccounts, await loadEmailsByUserId(db, boardAccountUserIds));

    if (!scriptArgs.apply) {
      return;
    }
    if (applyablePlans.length === 0) {
      console.info('');
      console.info(`${LOG_TAG} Nothing to apply.`);
      return;
    }

    const counts = await db.transaction(async (transaction) => applyRepairPlans(transaction, applyablePlans));

    console.info('');
    console.info(
      `${LOG_TAG} Repair complete: ${counts.ownershipRowsDeleted} ownership row(s), ${counts.pinsDeleted} pin(s), ` +
        `${counts.followsDeleted} follow(s) deleted, ${counts.tombstonesWritten} sync_deletions tombstone(s) written. ` +
        `No playlist, climb, tick, or credential was touched.`,
    );
    if (counts.skippedByDrift.length > 0) {
      console.info(
        `${LOG_TAG} Skipped ${counts.skippedByDrift.length} playlist(s): ${counts.skippedByDrift.join(', ')}`,
      );
    }
  } finally {
    await close();
  }
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(`${LOG_TAG} failed:`, error);
    process.exit(1);
  });
}
