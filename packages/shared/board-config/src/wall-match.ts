import type { WallCandidateSource, WallMatchKind } from '@boardsesh/shared-schema';
import { parseSetIds } from './set-ids';

/*
 * How an existing wall compares with the board a climber is about to set up
 * (#8151). The server's `existingWallCandidates` query and `createBoard`'s
 * opt-in recheck classify with this, and the app labels its shelves with the
 * same kinds, so both sides always agree on what "the same wall" means.
 *
 * Angle is never compared: an adjustable board's angle is a setting, not a
 * different wall.
 *
 * - `EXACT`: same board type, layout, size and hold sets. Set order and
 *   repeats are ignored ("25,24" and "24,25" are one setup), and ids are
 *   compared as numbers ("017" is set 17).
 * - `SETS_DIFFER`: same layout and size, different hold sets: a subset, a
 *   superset or an overlap. Usually the same wall entered with a set missing.
 * - `LAYOUT_OR_SIZE_DIFFERS`: same board type, another layout or size. Shown
 *   as a possible setup mismatch, never used to block a create.
 *
 * `WallCandidateSource` says where a candidate was found relative to the gym
 * the climber chose: on that gym, on a listing an admin merged into it, or on
 * another public listing within 150 m. Both enums are the GraphQL ones, defined
 * in @boardsesh/shared-schema.
 */
export type { WallCandidateSource, WallMatchKind };

/** The parts of a board's setup that identify a wall. */
export type WallSetup = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  /** Comma-separated, as the API carries it. */
  setIds: string;
};

/**
 * Set ids as numbers, deduped and sorted: "017,18", "18, 17" and "17,18,18"
 * are one setup. Compares numbers rather than `normaliseSetIds`' strings, which
 * keep a leading zero and so would call "017" and "17" different sets while
 * `diffWallSetIds` (which parses) found no difference between them.
 */
function setIdKey(setIds: string): string {
  return [...new Set(parseSetIds(setIds))].sort((first, second) => first - second).join(',');
}

/**
 * Compare a draft setup with an existing wall. Returns null when the board
 * types differ: a Kilter and a MoonBoard are never the same wall.
 */
export function classifyWallMatch(draft: WallSetup, candidate: WallSetup): WallMatchKind | null {
  if (draft.boardType !== candidate.boardType) return null;
  if (draft.layoutId !== candidate.layoutId || draft.sizeId !== candidate.sizeId) return 'LAYOUT_OR_SIZE_DIFFERS';
  return setIdKey(draft.setIds) === setIdKey(candidate.setIds) ? 'EXACT' : 'SETS_DIFFER';
}

/**
 * Which hold sets differ between a draft and a wall on the same layout and
 * size. `missingSetIds` are the draft's sets the wall lacks; `extraSetIds` are
 * the wall's sets the draft lacks. Both are sorted ascending. Set ids only
 * mean something within one layout, so a different layout or size, or a
 * different board type, returns two empty lists.
 */
export function diffWallSetIds(
  draft: WallSetup,
  candidate: WallSetup,
): { missingSetIds: number[]; extraSetIds: number[] } {
  if (classifyWallMatch(draft, candidate) !== 'SETS_DIFFER') return { missingSetIds: [], extraSetIds: [] };
  const draftSetIds = new Set(parseSetIds(draft.setIds));
  const wallSetIds = new Set(parseSetIds(candidate.setIds));
  const ascending = (first: number, second: number) => first - second;
  return {
    missingSetIds: [...draftSetIds].filter((setId) => !wallSetIds.has(setId)).sort(ascending),
    extraSetIds: [...wallSetIds].filter((setId) => !draftSetIds.has(setId)).sort(ascending),
  };
}

/** What `compareWallCandidates` ranks on. */
export type WallCandidateRankFields = {
  /** Null when no draft setup was given to compare with. */
  matchKind: WallMatchKind | null;
  source: WallCandidateSource;
  /** Metres between the chosen gym and the wall's gym; null when unknown or the same gym. */
  gymDistanceMeters: number | null;
  /** When the wall was added. The oldest copy of a wall is usually the one the crew climbs on. */
  createdAt: Date | string;
  uuid: string;
};

const MATCH_KIND_RANK: Record<WallMatchKind, number> = {
  EXACT: 0,
  SETS_DIFFER: 1,
  LAYOUT_OR_SIZE_DIFFERS: 2,
};
const NO_MATCH_KIND_RANK = 3;

const SOURCE_RANK: Record<WallCandidateSource, number> = {
  SELECTED_GYM: 0,
  MERGED_LISTING: 1,
  NEARBY_LISTING: 2,
};

function createdAtMillis(createdAt: Date | string): number {
  const millis = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  return Number.isNaN(millis) ? Number.POSITIVE_INFINITY : millis;
}

/**
 * Sort order for candidate walls, best first: closest match kind, then the
 * chosen gym before merged and nearby listings, then nearest gym (unknown
 * distance last), then oldest wall, then uuid. The uuid makes it a total
 * order, so a list never reshuffles between refetches.
 */
export function compareWallCandidates(first: WallCandidateRankFields, second: WallCandidateRankFields): number {
  const kindRank = (candidate: WallCandidateRankFields) =>
    candidate.matchKind == null ? NO_MATCH_KIND_RANK : MATCH_KIND_RANK[candidate.matchKind];
  const byKind = kindRank(first) - kindRank(second);
  if (byKind !== 0) return byKind;

  const bySource = SOURCE_RANK[first.source] - SOURCE_RANK[second.source];
  if (bySource !== 0) return bySource;

  const firstDistance = first.gymDistanceMeters ?? Number.POSITIVE_INFINITY;
  const secondDistance = second.gymDistanceMeters ?? Number.POSITIVE_INFINITY;
  if (firstDistance !== secondDistance) return firstDistance < secondDistance ? -1 : 1;

  const firstCreated = createdAtMillis(first.createdAt);
  const secondCreated = createdAtMillis(second.createdAt);
  if (firstCreated !== secondCreated) return firstCreated < secondCreated ? -1 : 1;

  if (first.uuid === second.uuid) return 0;
  return first.uuid < second.uuid ? -1 : 1;
}

/**
 * A hold set that is easy to leave out when entering a setup, because it is
 * bolted on separately from the main holds.
 */
export type SetupOmissionHint = {
  boardType: string;
  layoutId: number;
  setId: number;
  /** Stable key for the app's copy ("Missing Screw-on feet?"). */
  reason: 'screw_on_feet';
};

/**
 * The sets climbers forget. Ids are from `moonboard-metadata.ts`: MoonBoard
 * Masters 2017 is layout 4 with Screw-on Feet as set 15; Masters 2019 is
 * layout 5 with Screw-on Feet as set 20. A test pins both against the
 * metadata so a catalogue change can't silently point a hint at another set.
 */
export const SETUP_OMISSION_HINTS: readonly SetupOmissionHint[] = [
  { boardType: 'moonboard', layoutId: 4, setId: 15, reason: 'screw_on_feet' },
  { boardType: 'moonboard', layoutId: 5, setId: 20, reason: 'screw_on_feet' },
];

/**
 * The hints that apply to a setup: its layout has an easily forgotten set and
 * the setup leaves it out. A setup with no sets chosen yet gets none, since
 * the climber hasn't picked anything to forget from. Partial setups stay
 * allowed; this is a nudge, never a rule.
 */
export function likelySetupOmissions(setup: Pick<WallSetup, 'boardType' | 'layoutId' | 'setIds'>): SetupOmissionHint[] {
  const chosenSetIds = new Set(parseSetIds(setup.setIds));
  if (chosenSetIds.size === 0) return [];
  return SETUP_OMISSION_HINTS.filter(
    (hint) => hint.boardType === setup.boardType && hint.layoutId === setup.layoutId && !chosenSetIds.has(hint.setId),
  );
}
