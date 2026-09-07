import { catalogClimbUuid, terminalCanonicalUuid, type MoonBoardCatalogProblem } from './moonboard-catalog-helpers.js';

// =============================================================================
// Which listed MoonBoard climbs does the catalog no longer back?
// =============================================================================
// Pure classification, so the interesting part is testable without a database.
// report-moonboard-withdrawn.ts does the file reading and the queries.
// =============================================================================

/**
 * Why the catalog no longer backs a listed climb.
 *
 * The three are deliberately kept apart because they justify very different
 * actions. Only `withdrawn-upstream` is a claim the capture itself makes.
 */
export type WithdrawnReason =
  /** A problem in this capture carries `dateDeleted`. Upstream says it is gone. */
  | 'withdrawn-upstream'
  /** Present in the previous capture, absent from this one. Needs `--previous`. */
  | 'vanished-from-capture'
  /** No catalog problem resolves here at all — usually a legacy pre-catalog import. */
  | 'no-catalog-alias';

export type ListedClimb = {
  uuid: string;
  layoutId: number;
  name: string | null;
  setterUsername: string | null;
};

export type WithdrawnClimb = ListedClimb & { reason: WithdrawnReason };

export type CatalogProblemIndex = {
  /** Canonical uuids a live (importable) problem resolves to. */
  liveUuids: Set<string>;
  /** Canonical uuids only a soft-deleted problem resolves to. */
  withdrawnUuids: Set<string>;
  /** Canonical uuids only a problem missing from this capture resolves to. */
  vanishedUuids: Set<string>;
};

export type BuildCatalogProblemIndexArgs = {
  problems: Pick<MoonBoardCatalogProblem, 'id' | 'dateDeleted' | 'Active'>[];
  /** Problem ids from an earlier capture, for the `vanished-from-capture` class. */
  previousProblemIds?: Iterable<number>;
  canonicalByAlias: ReadonlyMap<string, string>;
};

/**
 * Group every catalog problem id by the canonical climb it resolves to.
 *
 * Resolution goes through the alias chain, so a problem the import merged onto
 * a pre-existing uuid still counts as backing that climb. A problem with no
 * alias row was never imported and backs nothing.
 *
 * A uuid a LIVE problem resolves to is never also reported as withdrawn or
 * vanished: two problems routinely collapse onto one climb, and one of them
 * disappearing does not mean the climb should stop being listed.
 */
export function buildCatalogProblemIndex(args: BuildCatalogProblemIndexArgs): CatalogProblemIndex {
  const { problems, previousProblemIds, canonicalByAlias } = args;

  const resolve = (problemId: number): string | undefined => {
    const aliasUuid = catalogClimbUuid({ id: problemId });
    if (!canonicalByAlias.has(aliasUuid)) return undefined;
    return terminalCanonicalUuid(aliasUuid, canonicalByAlias);
  };

  const liveUuids = new Set<string>();
  const withdrawnUuids = new Set<string>();
  const vanishedUuids = new Set<string>();
  const currentIds = new Set<number>();

  for (const problem of problems) {
    currentIds.add(problem.id);
    const canonicalUuid = resolve(problem.id);
    if (!canonicalUuid) continue;
    if (problem.dateDeleted || problem.Active === false) withdrawnUuids.add(canonicalUuid);
    else liveUuids.add(canonicalUuid);
  }

  for (const problemId of previousProblemIds ?? []) {
    if (currentIds.has(problemId)) continue;
    const canonicalUuid = resolve(problemId);
    if (canonicalUuid) vanishedUuids.add(canonicalUuid);
  }

  // A climb something still publishes is not withdrawn, whatever else points at it.
  for (const uuid of liveUuids) {
    withdrawnUuids.delete(uuid);
    vanishedUuids.delete(uuid);
  }
  // An explicit dateDeleted outranks "absent from a paginated capture".
  for (const uuid of withdrawnUuids) vanishedUuids.delete(uuid);

  return { liveUuids, withdrawnUuids, vanishedUuids };
}

/** Classify the listed climbs the catalog no longer backs, in a stable order. */
export function classifyWithdrawnClimbs(listed: ListedClimb[], index: CatalogProblemIndex): WithdrawnClimb[] {
  const classified: WithdrawnClimb[] = [];
  for (const climb of listed) {
    if (index.liveUuids.has(climb.uuid)) continue;
    const reason: WithdrawnReason = index.withdrawnUuids.has(climb.uuid)
      ? 'withdrawn-upstream'
      : index.vanishedUuids.has(climb.uuid)
        ? 'vanished-from-capture'
        : 'no-catalog-alias';
    classified.push({ ...climb, reason });
  }
  return classified;
}
