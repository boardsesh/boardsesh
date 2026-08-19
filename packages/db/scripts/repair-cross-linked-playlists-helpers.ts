/**
 * Pure classification logic for the cross-linked-playlist repair command
 * (#3541). Kept DB-free so it unit-tests without a database (mirrors
 * dedupe-beta-links-helpers.ts); the command module does all the I/O.
 *
 * Background: three now-fixed defects let one Aurora account attach a second
 * Boardsesh user's `owner` row onto a playlist someone else created —
 *
 *   1. the original JSON importer (8fe79f60d) derived `playlists.aurora_id`
 *      from `${boardType}:${name}:${created_at}` with no user id, so two
 *      people importing a circuit with the same name and creation timestamp
 *      collided on the global `playlists_aurora_id_idx` (fixed in 45cef340a,
 *      which added the user id to the hash);
 *   2. Aurora `user-sync`'s circuits path upserted on that same global index
 *      and then unconditionally inserted an `owner` row (fixed by the
 *      `foreignPlaylistOwnerGuard` setWhere, PR #3931);
 *   3. board links were not rejected when the same Aurora account was already
 *      linked to another Boardsesh user (fixed in 458a1490f).
 *
 * The guards stop NEW cross-links; they do not clean up the rows that already
 * exist. This module decides, per playlist, whether a cross-link is safe to
 * repair automatically and which of the two owners created it.
 */

/** Playlists imported from an Aurora JSON export carry this `aurora_id` prefix. */
export const JSON_IMPORT_CIRCUIT_AURORA_ID_PREFIX = 'json-import-circuit-';

/**
 * Two ownership rows must be at least this far apart in time before the
 * earlier one is trusted as "the creator". Marco's 2026-07-25 read-only
 * analysis of the 44 prod rows found a minimum spread of 100 minutes and a
 * maximum of 96 days, so 30 minutes clears every real pair with room to spare
 * while still refusing anything that would be a coin flip.
 */
export const DEFAULT_MIN_OWNERSHIP_SPREAD_MINUTES = 30;

const MILLISECONDS_PER_MINUTE = 60_000;

export type PlaylistOwnerRow = {
  userId: string;
  userEmail: string | null;
  role: string;
  createdAt: Date;
};

export type CrossLinkedPlaylist = {
  /** `playlists.id` as a decimal string — the column is a bigint. */
  playlistId: string;
  playlistUuid: string;
  name: string;
  boardType: string;
  auroraId: string | null;
  kilterId: string | null;
  isPublic: boolean;
  climbCount: number;
  /** Every ownership row on the playlist, in any order. */
  owners: PlaylistOwnerRow[];
};

/**
 * What the script will do with a playlist.
 *
 * - `revoke-adopter`: delete the later ownership row (Marco's Option A). The
 *   only action the apply path writes by default.
 * - `defer-to-account-merge`: the two owners are the same person's duplicate
 *   accounts (case-variant emails). `merge-accounts.ts` from PR #3278 collapses
 *   these correctly as a side effect of merging the accounts, and also moves the
 *   ticks and credentials this script deliberately never touches. Skipped unless
 *   `--include-merge-candidates` opts in, which routes it through the same
 *   revoke path as above.
 * - `refuse`: not safe to decide automatically. Reported, never written.
 */
export type CrossLinkRepairAction = 'revoke-adopter' | 'defer-to-account-merge' | 'refuse';

export type CrossLinkCause =
  | 'json-import'
  | 'duplicate-accounts'
  /** A cross-link this module cannot attribute to a known defect. Always refused. */
  | 'unknown';

export type CrossLinkRepairPlan = {
  playlist: CrossLinkedPlaylist;
  action: CrossLinkRepairAction;
  cause: CrossLinkCause;
  /** Human-readable justification, printed verbatim in the audit report. */
  reason: string;
  /** Earliest ownership row. Null when the playlist was refused before ordering. */
  creator: PlaylistOwnerRow | null;
  /** Later ownership row — the one `revoke-adopter` deletes. */
  adopter: PlaylistOwnerRow | null;
  /** Minutes between the two ownership rows, or null when not applicable. */
  spreadMinutes: number | null;
};

export type ClassifyOptions = {
  minSpreadMinutes?: number;
};

export function isJsonImportCircuit(auroraId: string | null): boolean {
  return auroraId !== null && auroraId.startsWith(JSON_IMPORT_CIRCUIT_AURORA_ID_PREFIX);
}

/**
 * True when two emails differ only by case (or whitespace) — i.e. the two
 * Boardsesh accounts exist only because `users.email` used to be
 * case-sensitive. `Pmbmosk@gmail.com` vs `pmbmosk@gmail.com` is the pair this
 * issue is about.
 */
export function isDuplicateAccountEmailPair(firstEmail: string | null, secondEmail: string | null): boolean {
  if (!firstEmail || !secondEmail) return false;
  return firstEmail.trim().toLowerCase() === secondEmail.trim().toLowerCase();
}

function sortOwnersByCreatedAt(owners: PlaylistOwnerRow[]): PlaylistOwnerRow[] {
  return [...owners].sort((first, second) => first.createdAt.getTime() - second.createdAt.getTime());
}

function refusal(playlist: CrossLinkedPlaylist, reason: string): CrossLinkRepairPlan {
  return { playlist, action: 'refuse', cause: 'unknown', reason, creator: null, adopter: null, spreadMinutes: null };
}

/**
 * Decide what to do with one multi-owner playlist.
 *
 * Refuses (never writes) when the shape is anything other than exactly two
 * `owner` rows separated by a clear margin: three-way cross-links, shared
 * playlists using the collaboration roles the schema already allows
 * (`editor`/`viewer`), invalid timestamps, and near-simultaneous rows all fall
 * out here rather than guessing.
 */
export function classifyCrossLinkedPlaylist(
  playlist: CrossLinkedPlaylist,
  options: ClassifyOptions = {},
): CrossLinkRepairPlan {
  const minSpreadMinutes = options.minSpreadMinutes ?? DEFAULT_MIN_OWNERSHIP_SPREAD_MINUTES;

  const distinctUserIds = new Set(playlist.owners.map((owner) => owner.userId));
  if (distinctUserIds.size < 2) {
    return refusal(playlist, `only ${distinctUserIds.size} distinct owner(s) — not a cross-link`);
  }
  if (distinctUserIds.size > 2) {
    return refusal(
      playlist,
      `${distinctUserIds.size} distinct owners — repairing a three-way cross-link needs a human`,
    );
  }

  const nonOwnerRoles = playlist.owners.filter((owner) => owner.role !== 'owner');
  if (nonOwnerRoles.length > 0) {
    const roleList = [...new Set(nonOwnerRoles.map((owner) => owner.role))].sort().join(', ');
    return refusal(
      playlist,
      `non-owner role(s) present (${roleList}) — looks like deliberate sharing, not a cross-link`,
    );
  }

  const invalidTimestamps = playlist.owners.filter((owner) => Number.isNaN(owner.createdAt.getTime()));
  if (invalidTimestamps.length > 0) {
    return refusal(playlist, 'ownership row with an unreadable created_at — cannot order creator vs adopter');
  }

  const [creator, adopter] = sortOwnersByCreatedAt(playlist.owners);
  const spreadMinutes = (adopter.createdAt.getTime() - creator.createdAt.getTime()) / MILLISECONDS_PER_MINUTE;
  const isDuplicateAccounts = isDuplicateAccountEmailPair(creator.userEmail, adopter.userEmail);

  // The spread check comes before the cause checks, including the
  // duplicate-account one: every action below either deletes the adopter's row
  // or can be opted into deleting it (--include-merge-candidates), so an
  // unorderable pair must be refused whatever caused it.
  if (spreadMinutes < minSpreadMinutes) {
    const duplicateAccountNote = isDuplicateAccounts
      ? '; the two owners are case-variant emails, so merge-accounts.ts (#3278) can still collapse this pair'
      : '';
    return {
      playlist,
      action: 'refuse',
      cause: isDuplicateAccounts ? 'duplicate-accounts' : 'unknown',
      reason: `ownership rows are only ${spreadMinutes.toFixed(1)} min apart (threshold ${minSpreadMinutes} min) — creator is a coin flip${duplicateAccountNote}`,
      creator,
      adopter,
      spreadMinutes,
    };
  }

  if (isDuplicateAccounts) {
    return {
      playlist,
      action: 'defer-to-account-merge',
      cause: 'duplicate-accounts',
      reason: `both owners are the same email up to case (${creator.userEmail} / ${adopter.userEmail}) — merge the accounts with merge-accounts.ts (#3278) instead, which also moves their ticks and credentials`,
      creator,
      adopter,
      spreadMinutes,
    };
  }

  if (!isJsonImportCircuit(playlist.auroraId)) {
    return {
      playlist,
      action: 'refuse',
      cause: 'unknown',
      reason: `aurora_id ${playlist.auroraId ?? '(null)'} is not a JSON-import circuit and the owners are different people — no known defect explains this cross-link`,
      creator,
      adopter,
      spreadMinutes,
    };
  }

  return {
    playlist,
    action: 'revoke-adopter',
    cause: 'json-import',
    reason: `JSON-import residue: the pre-45cef340a importer hashed aurora_id without a user id, so ${adopter.userEmail ?? adopter.userId}'s import adopted ${creator.userEmail ?? creator.userId}'s playlist`,
    creator,
    adopter,
    spreadMinutes,
  };
}

export function planCrossLinkedPlaylistRepairs(
  playlists: CrossLinkedPlaylist[],
  options: ClassifyOptions = {},
): CrossLinkRepairPlan[] {
  return playlists.map((playlist) => classifyCrossLinkedPlaylist(playlist, options));
}

export type RepairPlanSummary = {
  playlists: number;
  ownershipRows: number;
  revokeAdopter: number;
  deferToAccountMerge: number;
  refused: number;
};

export function summarizeRepairPlans(plans: CrossLinkRepairPlan[]): RepairPlanSummary {
  return {
    playlists: plans.length,
    ownershipRows: plans.reduce((total, plan) => total + plan.playlist.owners.length, 0),
    revokeAdopter: plans.filter((plan) => plan.action === 'revoke-adopter').length,
    deferToAccountMerge: plans.filter((plan) => plan.action === 'defer-to-account-merge').length,
    refused: plans.filter((plan) => plan.action === 'refuse').length,
  };
}

/**
 * The plans the apply path is allowed to write, honouring the
 * `--include-merge-candidates` opt-in. Duplicate-account pairs stay off by
 * default: `merge-accounts.ts` (#3278) is the right tool for them, and running
 * it after this script would find the ownership rows already deduped.
 */
export function selectApplyablePlans(
  plans: CrossLinkRepairPlan[],
  { includeMergeCandidates }: { includeMergeCandidates: boolean },
): CrossLinkRepairPlan[] {
  return plans.filter((plan) => {
    if (plan.action === 'revoke-adopter') return true;
    return includeMergeCandidates && plan.action === 'defer-to-account-merge';
  });
}
