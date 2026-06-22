/**
 * Pure grouping + keep-selection logic for the beta-link dedupe command. Kept
 * DB-free so it unit-tests without a database (mirrors
 * aurora-board-import-helpers.ts); the command module does the I/O.
 */
import { betaLinkIdentity } from '@boardsesh/shared-schema';

export type BetaLinkRow = {
  // Identity (the table PK) — never merged.
  boardType: string;
  climbUuid: string;
  link: string;
  // Nullable, non-identity columns — any of these can be recovered onto the
  // survivor from a duplicate that's about to be deleted.
  foreignUsername: string | null;
  angle: number | null;
  thumbnail: string | null;
  isListed: boolean | null;
  createdAt: string | null;
  tickUuid: string | null;
  boardId: number | null;
  shortcode: string | null;
  videoIdentity: string | null;
  createdByUserId: string | null;
};

// Every nullable, non-identity column. The survivor keeps the row whose `link`
// wins the keep-priority sort, but inherits any of these columns it is missing
// from the rows being removed, so --apply never drops metadata that lived only
// on a duplicate. Identity columns (boardType/climbUuid/link) are excluded.
const MERGEABLE_BETA_LINK_FIELDS = [
  'foreignUsername',
  'angle',
  'thumbnail',
  'isListed',
  'createdAt',
  'tickUuid',
  'boardId',
  'shortcode',
  'videoIdentity',
  'createdByUserId',
] as const;
export type MergeableBetaLinkField = (typeof MERGEABLE_BETA_LINK_FIELDS)[number];
export type BetaLinkBackfill = Partial<Pick<BetaLinkRow, MergeableBetaLinkField>>;

export type BetaLinkDuplicateGroup = {
  key: string;
  keep: BetaLinkRow;
  remove: BetaLinkRow[];
  // Columns to copy onto the survivor before the duplicates are deleted, so a
  // field only a removed row carried (e.g. an `angle` or `thumbnail`) survives.
  // Empty when the survivor already has every populated field in the group.
  backfill: BetaLinkBackfill;
};

// Two rows are "the same video on the same climb" when board + climb + the
// platform-stable video identity (Instagram shortcode / TikTok id) match — even
// when the stored URL text differs (/p/ vs /reel/, trailing slash, `?igsh=`
// tracking params). The table PK is (board_type, climb_uuid, link), so two rows
// sharing this key always differ by `link`, which is what makes a row-level
// delete unambiguous. NUL separators can't appear in any field's contents, so
// distinct (board, climb, identity) triples can never collapse onto one key.
// Written as the `\0` escape (not a literal NUL byte) so this stays plain text.
export function betaLinkDedupeKey(row: Pick<BetaLinkRow, 'boardType' | 'climbUuid' | 'link'>): string {
  return `${row.boardType}\0${row.climbUuid}\0${betaLinkIdentity(row.link)}`;
}

const isPresent = (value: unknown): boolean => value !== null && value !== undefined;

// Earliest non-null created_at wins; nulls sort last.
function compareCreatedAt(first: string | null, second: string | null): number {
  if (first === second) return 0;
  if (first === null) return 1;
  if (second === null) return -1;
  return first < second ? -1 : 1;
}

// Lower sorts first = kept. Prefer the richest, most canonical row so the
// survivor is the one already covered by the `video_identity` unique index
// (which blocks future duplicates), then attribution, then a linked ascent,
// then angle, then thumbnail, then the oldest row, with the link as a
// deterministic final tiebreak. This decides only which row (and its `link`)
// survives — backfillBetaLinkMetadata then tops the survivor up with anything it
// is missing, so the ranking never costs us metadata that lived on a loser.
export function compareBetaLinkKeepPriority(first: BetaLinkRow, second: BetaLinkRow): number {
  const byPresence = (left: unknown, right: unknown): number => (isPresent(left) ? 0 : 1) - (isPresent(right) ? 0 : 1);
  return (
    byPresence(first.videoIdentity, second.videoIdentity) ||
    byPresence(first.createdByUserId, second.createdByUserId) ||
    byPresence(first.tickUuid, second.tickUuid) ||
    byPresence(first.angle, second.angle) ||
    byPresence(first.thumbnail, second.thumbnail) ||
    compareCreatedAt(first.createdAt, second.createdAt) ||
    first.link.localeCompare(second.link)
  );
}

// Copy one missing column onto the survivor from the first removed row (in
// keep-priority order) that has a value for it. Generic over a single field so
// the value and target types line up without `any`.
function backfillField<Field extends MergeableBetaLinkField>(
  backfill: BetaLinkBackfill,
  keep: BetaLinkRow,
  remove: BetaLinkRow[],
  field: Field,
): void {
  if (isPresent(keep[field])) return;
  const donor = remove.find((row) => isPresent(row[field]));
  if (donor) backfill[field] = donor[field];
}

// A dedupe that keeps the video_identity row can otherwise drop an `angle` or
// `thumbnail` that only a duplicate carried (migration 0128 backfilled
// video_identity onto a single URL variant without ranking by angle). Recover
// every NULL column on the survivor from the first removed row (in keep-priority
// order) that has it, so --apply is lossless. Returns only the columns that
// changed; an empty object means the survivor already had every populated field.
export function backfillBetaLinkMetadata(keep: BetaLinkRow, remove: BetaLinkRow[]): BetaLinkBackfill {
  const backfill: BetaLinkBackfill = {};
  for (const field of MERGEABLE_BETA_LINK_FIELDS) {
    backfillField(backfill, keep, remove, field);
  }
  return backfill;
}

export function chooseBetaLinkToKeep(group: BetaLinkRow[]): {
  keep: BetaLinkRow;
  remove: BetaLinkRow[];
  backfill: BetaLinkBackfill;
} {
  if (group.length === 0) {
    throw new Error('chooseBetaLinkToKeep called with an empty group');
  }
  const [keep, ...remove] = [...group].sort(compareBetaLinkKeepPriority);
  return { keep, remove, backfill: backfillBetaLinkMetadata(keep, remove) };
}

// Group rows by (board, climb, video identity) and return only the groups with
// a genuine duplicate (2+ rows), each resolved into a keeper, the rows to
// remove, and any metadata to recover onto the keeper first.
export function groupDuplicateBetaLinks(rows: BetaLinkRow[]): BetaLinkDuplicateGroup[] {
  const byKey = new Map<string, BetaLinkRow[]>();
  for (const row of rows) {
    const key = betaLinkDedupeKey(row);
    const existing = byKey.get(key);
    if (existing) existing.push(row);
    else byKey.set(key, [row]);
  }

  const groups: BetaLinkDuplicateGroup[] = [];
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    const { keep, remove, backfill } = chooseBetaLinkToKeep(list);
    groups.push({ key, keep, remove, backfill });
  }
  return groups;
}
