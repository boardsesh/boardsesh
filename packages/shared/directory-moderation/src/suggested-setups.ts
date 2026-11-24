import { normaliseSetIds } from '@boardsesh/board-config';

/**
 * The setups climbers suggested on "Set up wrong" reports, as the people who
 * review them see them (docs/product/directory-reports.md, "Suggested setup"):
 * grouped by equal setup ("2 climbers suggested …"), compared with the
 * board's setup now, and turned into the `updateBoard` input **Use this
 * setup** sends. The app's review sheet and www's review dialog both read
 * these, so the two agree on what counts as the same setup.
 *
 * Two setups are the same when the layout, the size, the hold sets in
 * `normaliseSetIds` order (so order and repeats don't count) and the angle
 * match. A setup without an angle (a board that tilts, where the angle isn't
 * part of the setup) has a null angle; a missing angle reads the same.
 */

/** A setup as `BoardSetup` and `BoardSetupInput` carry it. */
export type SuggestedSetup = {
  layoutId: number;
  sizeId: number;
  /** Hold set ids, comma-separated, in any order. */
  setIds: string;
  /** Only on a board that doesn't tilt; null or missing otherwise. */
  angle?: number | null;
};

/** A setup in canonical form: sets in `normaliseSetIds` order, no angle as null. */
export type CanonicalSetup = {
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number | null;
};

/** The board's setup now, to compare a suggestion with. */
export type CurrentBoardSetupForComparison = {
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle?: number | null;
};

/** One string per setup, equal for equal setups. Also a stable React key. */
export function setupKey(setup: SuggestedSetup): string {
  return [setup.layoutId, setup.sizeId, normaliseSetIds(setup.setIds), setup.angle ?? ''].join(':');
}

function canonicalSetup(setup: SuggestedSetup): CanonicalSetup {
  return {
    layoutId: setup.layoutId,
    sizeId: setup.sizeId,
    setIds: normaliseSetIds(setup.setIds),
    angle: setup.angle ?? null,
  };
}

/** Climbers who suggested the same setup. Reporters stay anonymous: a group is a count. */
export type SuggestedSetupGroup = {
  /** {@link setupKey} of the setup. */
  key: string;
  setup: CanonicalSetup;
  count: number;
};

/** A reporter's note as `DirectoryReportNote` carries it: only the suggestion and when it was made are read. */
export type SuggestedSetupNote = {
  suggestedSetup?: SuggestedSetup | null;
  createdAt?: string | null;
};

/**
 * The setups these notes suggest, one group per equal setup, the most
 * suggested first. Equal counts put the setup suggested most recently first
 * (by `createdAt`), then the one that appears first in `notes`. Notes without
 * a suggestion are skipped. Pass the notes of every report the group should
 * cover; leave out a setup the board already has with {@link setupMatches}.
 */
export function groupSuggestedSetups(notes: readonly SuggestedSetupNote[]): SuggestedSetupGroup[] {
  const groups = new Map<string, SuggestedSetupGroup & { latestAt: number; firstSeen: number }>();
  notes.forEach((note, index) => {
    const suggested = note.suggestedSetup;
    if (!suggested) return;
    const key = setupKey(suggested);
    const parsedAt = note.createdAt ? Date.parse(note.createdAt) : Number.NaN;
    const suggestedAt = Number.isNaN(parsedAt) ? Number.NEGATIVE_INFINITY : parsedAt;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      group.latestAt = Math.max(group.latestAt, suggestedAt);
    } else {
      groups.set(key, { key, setup: canonicalSetup(suggested), count: 1, latestAt: suggestedAt, firstSeen: index });
    }
  });
  return [...groups.values()]
    .sort(
      (first, second) =>
        second.count - first.count || second.latestAt - first.latestAt || first.firstSeen - second.firstSeen,
    )
    .map(({ key, setup, count }) => ({ key, setup, count }));
}

/**
 * Whether the board already has this setup, so **Use this setup** would
 * change nothing: the same layout, size and sets, and the same angle when the
 * setup names one (a setup without an angle leaves the angle out).
 */
export function setupMatches(setup: SuggestedSetup, current: CurrentBoardSetupForComparison): boolean {
  return (
    setup.layoutId === current.layoutId &&
    setup.sizeId === current.sizeId &&
    normaliseSetIds(setup.setIds) === normaliseSetIds(current.setIds) &&
    (setup.angle == null || setup.angle === current.angle)
  );
}

/** The `UpdateBoardInput` fields **Use this setup** sends. */
export type SuggestedSetupUpdateInput = {
  boardUuid: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle?: number;
  allowDuplicateConfig?: boolean;
};

/**
 * **Use this setup** as an `updateBoard` input: the layout, size and sets (in
 * canonical order), and the angle only when the setup carries one (a board
 * that doesn't tilt). `allowDuplicateConfig` once the person says it is a
 * different wall from the owner's other board with this setup, as on the
 * edit screen. The server closes the board's "Set up wrong" reports as fixed
 * when it saves.
 */
export function suggestedSetupUpdateInput(
  boardUuid: string,
  setup: SuggestedSetup,
  options: { allowDuplicateConfig?: boolean } = {},
): SuggestedSetupUpdateInput {
  return {
    boardUuid,
    layoutId: setup.layoutId,
    sizeId: setup.sizeId,
    setIds: normaliseSetIds(setup.setIds),
    ...(setup.angle != null ? { angle: setup.angle } : {}),
    ...(options.allowDuplicateConfig ? { allowDuplicateConfig: true } : {}),
  };
}
