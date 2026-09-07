import {
  buildExistingCatalogMatchIndex,
  catalogFingerprintKey,
  catalogClimbUuid,
  catalogProblemToClimbs,
  existingClimbUuidsForProblem,
  hijackedClimbUuidsForProblem,
  legacyCatalogClimbUuid,
  ownedClimbAngles,
  parseMovesString,
  resolveCatalogClimbUuid,
  terminalCanonicalUuid,
  type MoonBoardCatalogProblem,
} from './moonboard-catalog-helpers.js';
import { fingerprintFromHolds } from './moonboard-2024-helpers.js';

export type ReconciliationStats = { angle: number; upstream: number | null };
export type ReconciliationClimb = {
  uuid: string;
  layoutId: number;
  name: string | null;
  angle: number | null;
  createdAt: string | null;
  isListed: boolean | null;
  isDraft: boolean | null;
  userId: string | null;
  framesCount: number | null;
  fingerprint: string | null;
  stats: ReconciliationStats[];
};
export type CatalogEntry = { layoutId: number; problem: MoonBoardCatalogProblem };
export type ReconciliationSnapshot = {
  climbs: ReconciliationClimb[];
  aliases: ReadonlyMap<string, string>;
};
export type Hold = { holdId: number; holdState: string };
export type UsageCounts = { ticks: number; favourites: number; playlists: number; beta: number };

/** Must match the immutable 0222 migration's live canonical-root selection. */
export function planResidualGroups({ climbs, aliases }: ReconciliationSnapshot) {
  const candidates = new Map<string, ReconciliationClimb[]>();
  for (const climb of climbs) {
    if (
      climb.userId !== null ||
      climb.isDraft !== false ||
      climb.isListed !== true ||
      climb.framesCount !== 1 ||
      !climb.fingerprint
    )
      continue;
    const key = catalogFingerprintKey(climb.layoutId, climb.fingerprint);
    const bucket = candidates.get(key) ?? [];
    bucket.push(climb);
    candidates.set(key, bucket);
  }
  const groups = [];
  for (const [key, members] of candidates) {
    const roots = members.filter((climb) => !aliases.has(climb.uuid) || aliases.get(climb.uuid) === climb.uuid);
    if (roots.length < 2) continue;
    const rootUuids = new Set(roots.map((climb) => climb.uuid));
    const conflicts = members.filter((climb) => {
      const target = aliases.get(climb.uuid);
      return target !== undefined && target !== climb.uuid && !rootUuids.has(target);
    });
    const upstreamScore = (climb: ReconciliationClimb) =>
      climb.stats.find((stat) => stat.angle === climb.angle)?.upstream ??
      Math.max(0, ...climb.stats.map((stat) => stat.upstream ?? 0));
    roots.sort((left, right) => {
      const countDifference = upstreamScore(right) - upstreamScore(left);
      if (countDifference !== 0) return countDifference;
      if (left.createdAt !== right.createdAt) {
        if (left.createdAt === null) return 1;
        if (right.createdAt === null) return -1;
        return left.createdAt < right.createdAt ? -1 : 1;
      }
      return left.uuid < right.uuid ? -1 : left.uuid === right.uuid ? 0 : 1;
    });
    const statsByAngle = new Map<number, { name: string | null; upstream: number }[]>();
    for (const root of roots) {
      for (const stat of root.stats) {
        const contributors = statsByAngle.get(stat.angle) ?? [];
        contributors.push({ name: root.name?.toLowerCase() ?? null, upstream: stat.upstream ?? 0 });
        statsByAngle.set(stat.angle, contributors);
      }
    }
    groups.push({
      key,
      layoutId: roots[0].layoutId,
      canonicalUuid: roots[0].uuid,
      memberUuids: roots.map((root) => root.uuid),
      eligible: conflicts.length === 0,
      conflictingRedirectUuids: conflicts.map((climb) => climb.uuid).sort(),
      stats: [...statsByAngle]
        .sort(([left], [right]) => left - right)
        .map(([angle, contributors]) => {
          const identical =
            contributors[0].name !== null &&
            contributors.every(
              (contributor) =>
                contributor.name === contributors[0].name && contributor.upstream === contributors[0].upstream,
            );
          return {
            angle,
            policy: identical ? ('MAX' as const) : ('SUM' as const),
            upstream: identical
              ? contributors[0].upstream
              : contributors.reduce((total, contributor) => total + contributor.upstream, 0),
          };
        }),
    });
  }
  return groups.sort((left, right) => (left.key < right.key ? -1 : left.key === right.key ? 0 : 1));
}

export function holdDifferences(stored: readonly Hold[], current: readonly Hold[]) {
  const storedById = new Map(stored.map((hold) => [hold.holdId, hold.holdState]));
  const currentById = new Map(current.map((hold) => [hold.holdId, hold.holdState]));
  return {
    added: current.filter((hold) => !storedById.has(hold.holdId)),
    removed: stored.filter((hold) => !currentById.has(hold.holdId)),
    changedRoles: current
      .filter((hold) => storedById.has(hold.holdId) && storedById.get(hold.holdId) !== hold.holdState)
      .map((hold) => ({ holdId: hold.holdId, before: storedById.get(hold.holdId), after: hold.holdState })),
  };
}

export function buildReconciliationReport(
  current: CatalogEntry[],
  previous: CatalogEntry[],
  snapshot: ReconciliationSnapshot,
) {
  const catalogClimbs = snapshot.climbs.filter((climb) => climb.userId === null);
  const fingerprints = new Map(
    catalogClimbs.flatMap((climb) => (climb.fingerprint ? [[climb.uuid, climb.fingerprint] as const] : [])),
  );
  const index = buildExistingCatalogMatchIndex(catalogClimbs, fingerprints, snapshot.aliases);
  const existingUuids = new Set(catalogClimbs.map((climb) => climb.uuid));
  const previousById = new Map(previous.map((entry) => [`${entry.layoutId}:${entry.problem.id}`, entry.problem]));
  const groups = planResidualGroups(snapshot);
  const groupByKey = new Map(groups.map((group) => [group.key, group]));
  const projectedAliases = new Map(snapshot.aliases);
  const retired = new Set<string>();
  for (const group of groups) {
    if (!group.eligible) continue;
    for (const uuid of group.memberUuids) {
      if (uuid === group.canonicalUuid) continue;
      projectedAliases.set(uuid, group.canonicalUuid);
      retired.add(uuid);
    }
  }
  const projectedClimbs = catalogClimbs.map((climb) =>
    retired.has(climb.uuid) ? { ...climb, isListed: false } : climb,
  );
  const projectedIndex = buildExistingCatalogMatchIndex(projectedClimbs, fingerprints, projectedAliases);
  const counts = { ambiguous: 0, drifted: 0, hijacked: 0 };
  const projectedCounts = { ambiguous: 0, drifted: 0, hijacked: 0 };
  const skipped = [];
  const ordered = [...current].sort(
    (left, right) => left.layoutId - right.layoutId || left.problem.id - right.problem.id,
  );
  for (const { layoutId, problem } of ordered) {
    const mapped = catalogProblemToClimbs(problem, layoutId);
    if (!mapped) continue;
    const angles = ownedClimbAngles(mapped.stats.map((stat) => stat.angle));
    const classify = (matchIndex: typeof index, aliases: ReadonlyMap<string, string>) => {
      const match = resolveCatalogClimbUuid(mapped, matchIndex);
      if (match.ambiguous) return 'ambiguous' as const;
      if (
        !match.matched &&
        existingClimbUuidsForProblem({ problemId: problem.id, angles, existingClimbUuids: existingUuids }).length
      )
        return 'drifted' as const;
      if (
        match.matched &&
        hijackedClimbUuidsForProblem({
          problemId: problem.id,
          angles,
          resolvedUuid: match.uuid,
          existingClimbUuids: existingUuids,
          canonicalByAlias: aliases,
        }).length
      )
        return 'hijacked' as const;
      return null;
    };
    const reason = classify(index, snapshot.aliases);
    const projectedReason = classify(projectedIndex, projectedAliases);
    if (projectedReason) projectedCounts[projectedReason]++;
    if (!reason) continue;
    counts[reason]++;
    const key = catalogFingerprintKey(layoutId, mapped.holdFingerprint);
    const ownedUuids = existingClimbUuidsForProblem({
      problemId: problem.id,
      angles,
      existingClimbUuids: existingUuids,
    });
    const candidateUuids = [...new Set((index.get(key) ?? []).map((candidate) => candidate.uuid))].sort();
    const olderProblem = previousById.get(`${layoutId}:${problem.id}`);
    // History is about holds, even when a prior configuration was ungraded or
    // withdrawn. Do not let catalogProblemToClimbs's importability filter erase it.
    let previousFingerprint: string | null = null;
    let previousParseError: string | null = null;
    if (olderProblem?.moves) {
      try {
        previousFingerprint = fingerprintFromHolds(parseMovesString(olderProblem.moves));
      } catch (error) {
        previousParseError = error instanceof Error ? error.message : String(error);
      }
    }
    const group = groupByKey.get(key);
    const identityAliases = [
      catalogClimbUuid(problem),
      ...angles.map((angle) => legacyCatalogClimbUuid({ id: problem.id, angle })),
    ]
      .filter((uuid) => existingUuids.has(uuid) || snapshot.aliases.has(uuid))
      .map((uuid) => ({
        uuid,
        isClimbRow: existingUuids.has(uuid),
        redirect: snapshot.aliases.get(uuid) ?? null,
        terminalUuid: terminalCanonicalUuid(uuid, snapshot.aliases) ?? null,
      }));
    skipped.push({
      problemId: problem.id,
      name: problem.name,
      layoutId,
      reason,
      projectedReason,
      candidateUuids,
      ownedUuids,
      identityAliases,
      referencedUuids: [
        ...new Set(
          [
            ...candidateUuids,
            ...ownedUuids,
            ...(group?.memberUuids ?? []),
            ...(group?.conflictingRedirectUuids ?? []),
            ...identityAliases.map((alias) => alias.uuid),
          ].flatMap((uuid) =>
            [uuid, terminalCanonicalUuid(uuid, snapshot.aliases)].filter(
              (target): target is string => target !== undefined,
            ),
          ),
        ),
      ].sort(),
      currentHolds: mapped.holds,
      history: {
        status: previousParseError
          ? 'unparseable-previous-moves'
          : previousFingerprint === null
            ? 'no-previous-holds'
            : previousFingerprint === mapped.holdFingerprint
              ? 'unchanged-holds'
              : 'changed-holds',
        rawMovesChanged: olderProblem ? olderProblem.moves !== problem.moves : null,
        previousMoves: olderProblem?.moves ?? null,
        currentMoves: problem.moves,
        previousFingerprint,
        currentFingerprint: mapped.holdFingerprint,
        previousParseError,
      },
      migrationGroup: group ?? null,
    });
  }
  return { counts, projectedCounts, groups, skipped };
}
