import type { boardClimbs, boardClimbStats, boardClimbHolds, boardClimbAliases } from '../src/schema/boards/unified.js';
import {
  catalogAliasRows,
  catalogFingerprintKey,
  catalogProblemToClimbs,
  existingClimbUuidsForProblem,
  hijackedClimbUuidsForProblem,
  holdsBatchKey,
  ownedClimbAngles,
  problemSkipReason,
  resolveCatalogClimbUuid,
  resolveIncumbentReplacement,
  statsBatchKey,
  withdrawnCanonicalUuids,
  type ExistingCatalogClimb,
  type MappedCatalogClimb,
  type MoonBoardCatalogProblem,
} from './moonboard-catalog-helpers.js';
import { recordUnmappedMoonBoardGrade } from './moonboard-helpers.js';

// =============================================================================
// Staging one catalog file's rows
// =============================================================================
// Everything the importer decides per problem — merge target, the skip guards,
// the same-holds collapse, and which climbs a withdrawn problem leaves behind —
// happens here, so it can be exercised without a database.
// import-moonboard-catalog.ts keeps the I/O: reading files, building the match
// index, and writing the rows this returns.
// =============================================================================

export type CatalogClimbRow = typeof boardClimbs.$inferInsert;
export type CatalogStatsRow = typeof boardClimbStats.$inferInsert;
export type CatalogHoldRow = typeof boardClimbHolds.$inferInsert;
export type CatalogAliasRow = typeof boardClimbAliases.$inferInsert;

export type CatalogBatchCounters = {
  /** Problems merged onto a climb row that already existed in the database. */
  matched: number;
  /** Problems staged as a brand new climb row. */
  inserted: number;
  /** Problems the mapper rejected (deleted, holdless, no graded configuration). */
  skippedProblems: number;
  /** Skipped: several listed rows already share the problem's holds. */
  skippedAmbiguous: number;
  /** Skipped: hold-match miss, but the problem already owns climb rows. */
  skippedDrifted: number;
  /** Skipped: merging would repoint a live climb row the problem owns. */
  skippedHijacked: number;
  /** Later problems folded onto an earlier same-holds problem in this batch. */
  foldedInBatch: number;
  /** Problems upstream has withdrawn (a subset of skippedProblems). */
  withdrawn: number;
  /** Withdrawn problems that resolved to a climb row we can stop listing. */
  withdrawnWithClimbs: number;
};

export type WithdrawnProblemSample = {
  problemId: number;
  name: string;
  climbUuids: string[];
};

export type CatalogBatchStaging = {
  climbs: CatalogClimbRow[];
  stats: CatalogStatsRow[];
  holds: CatalogHoldRow[];
  aliases: CatalogAliasRow[];
  /**
   * Climbs to stop listing: every climb a withdrawn problem still owns, minus
   * every climb this batch actually wrote. The subtraction is the point — two
   * problems can share holds and collapse onto one climb, so a withdrawn
   * problem can resolve to a uuid a LIVE problem in the same file also writes.
   * Unlisting that would hide a climb upstream still publishes.
   */
  withdrawnClimbUuids: string[];
  /** First few withdrawn problems, for an operator-facing sample in the log. */
  withdrawnSamples: WithdrawnProblemSample[];
  counters: CatalogBatchCounters;
  /**
   * Setter grade string → how many graded configurations spelled it, for the
   * grades MOONBOARD_GRADE_TO_DIFFICULTY has no difficulty id for. Counted for
   * every configuration the mapper emitted, before the dedupe/skip branches:
   * the point is to name a grade the catalog contains but the map cannot
   * resolve, which is a property of the catalog file, not of what we wrote.
   */
  unmappedGrades: Map<string, number>;
};

export type StageCatalogBatchArgs = {
  problems: MoonBoardCatalogProblem[];
  layoutId: number;
  /** `${layoutId}|${fingerprint}` → existing listed climbs, from buildExistingCatalogMatchIndex. */
  existingIndex: Map<string, ExistingCatalogClimb[]>;
  /** Every existing MoonBoard climb uuid, listed or not. */
  existingClimbUuids: ReadonlySet<string>;
  /** alias_uuid → canonical_uuid for MoonBoard, used to tell a merge from a hijack. */
  canonicalByAlias: ReadonlyMap<string, string>;
  /** Stamped on every stats row this batch writes. */
  upstreamSyncedAt?: string;
  onWarning?: (message: string) => void;
};

/** How many withdrawn problems to keep for the run log. Enough to eyeball, not enough to drown it. */
const WITHDRAWN_SAMPLE_LIMIT = 10;

export function stageCatalogBatch(args: StageCatalogBatchArgs): CatalogBatchStaging {
  const { problems, layoutId, existingIndex, existingClimbUuids, canonicalByAlias } = args;
  const upstreamSyncedAt = args.upstreamSyncedAt ?? new Date().toISOString();
  const warn = args.onWarning ?? ((message: string) => console.error(message));

  // Dedupe in memory keyed per conflict target so a single batch never
  // proposes the same target twice ("ON CONFLICT cannot affect row a second
  // time"). When two problems share the same holds (so they resolve to one
  // target UUID) we keep the STRONGER problem (resolveIncumbentReplacement /
  // isBetterCatalogClimb: more total repeats across its graded angles, then
  // benchmark) instead of last-wins — otherwise a junk duplicate can
  // clobber a real benchmark's ascent count and benchmark flag.
  const bestByUuid = new Map<string, MappedCatalogClimb>();
  const climbByUuid = new Map<string, CatalogClimbRow>();
  // Keyed by statsBatchKey — one entry per graded angle of a climb.
  const statsByUuidAngle = new Map<string, CatalogStatsRow>();
  const holdsByKey = new Map<string, CatalogHoldRow>();
  const aliasByUuid = new Map<string, CatalogAliasRow>();
  // `${layoutId}|${fingerprint}` → the uuid this batch already staged for those
  // holds, for problems that matched nothing in the database (see the fold below).
  const stagedUuidByFingerprint = new Map<string, string>();

  // Climbs a withdrawn problem still owns. Collected across the whole file and
  // filtered against `climbByUuid` at the end (see CatalogBatchStaging).
  const withdrawnUuids = new Set<string>();
  const withdrawnSamples: WithdrawnProblemSample[] = [];

  const counters: CatalogBatchCounters = {
    matched: 0,
    inserted: 0,
    skippedProblems: 0,
    skippedAmbiguous: 0,
    skippedDrifted: 0,
    skippedHijacked: 0,
    foldedInBatch: 0,
    withdrawn: 0,
    withdrawnWithClimbs: 0,
  };

  // Grade strings the shared map has no difficulty id for. Those configurations
  // still import, but with a NULL grade — indistinguishable from an ungraded
  // project once they're in the table, so name them in the run log.
  const unmappedGrades = new Map<string, number>();

  for (const problem of problems) {
    if (problemSkipReason(problem) === 'withdrawn') {
      counters.skippedProblems++;
      counters.withdrawn++;
      // ownedClimbAngles([]) — every angle MoonBoard has ever been imported at.
      // A withdrawn problem's own configurations are unreliable here: they are
      // often soft-deleted alongside it, so "the angles it is graded at today"
      // would miss the rows it actually owns.
      const climbUuids = withdrawnCanonicalUuids({
        problemId: problem.id,
        angles: ownedClimbAngles([]),
        existingClimbUuids,
        canonicalByAlias,
      });
      if (climbUuids.length > 0) {
        counters.withdrawnWithClimbs++;
        for (const uuid of climbUuids) withdrawnUuids.add(uuid);
        if (withdrawnSamples.length < WITHDRAWN_SAMPLE_LIMIT) {
          withdrawnSamples.push({ problemId: problem.id, name: problem.name, climbUuids });
        }
      }
      continue;
    }

    const mapped = catalogProblemToClimbs(problem, layoutId);
    if (!mapped) {
      counters.skippedProblems++;
      continue;
    }
    for (const stat of mapped.stats) {
      if (stat.difficultyId === undefined) recordUnmappedMoonBoardGrade(unmappedGrades, stat.sourceGrade);
    }
    const resolved = resolveCatalogClimbUuid(mapped, existingIndex);

    // Multiple DISTINCT listed rows share this problem's holds. Two causes:
    //   1. The moonboard_angle_dedup_backfill migration (#3849) hasn't run against this
    //      database yet, so both angle-rows of the problem are still
    //      separately listed. Running it fixes this one.
    //   2. The database IS migrated, but the dedup migration deliberately left this group
    //      alone: it only collapses a same-signature group whose members
    //      all sit at DISTINCT angles, so a cross-problem duplicate class
    //      (the real "birthday cake trail mix" vs the junk problem named
    //      "name", four listed rows on one signature) survives for manual
    //      follow-up. Running migrations again changes nothing here.
    // Either way, writing through would double-count ascents across two
    // listed rows and point a legacy alias at whichever row the name
    // tie-break happened to land on. Loud skip, not a silent guess.
    if (resolved.ambiguous) {
      counters.skippedAmbiguous++;
      warn(
        `   ⚠️  Skipping problem ${problem.id} ("${problem.name}"): multiple listed rows already share its holds ` +
          `at layout ${layoutId} — either this database predates the moonboard_angle_dedup_backfill migration (#3849), or that migration ` +
          `ran and left a cross-problem duplicate group for manual follow-up. Check migrations first; if they're ` +
          `up to date, these rows need deduping by hand.`,
      );
      continue;
    }

    // Both guards below ask "which climb rows does this problem already own?"
    // over the same angle set: today's graded angles plus every angle MoonBoard
    // has ever been imported at (see ownedClimbAngles).
    const angles = ownedClimbAngles(mapped.stats.map((stat) => stat.angle));

    if (!resolved.matched) {
      // No hold match, but this problem already owns climb rows from an
      // earlier import — its holds drifted rather than it being new. See
      // existingClimbUuidsForProblem: inserting here would mint a duplicate
      // and repoint the old rows' self-aliases (and therefore their ticks)
      // at the empty new row. Loud skip.
      const driftedUuids = existingClimbUuidsForProblem({
        problemId: problem.id,
        angles,
        existingClimbUuids,
      });
      if (driftedUuids.length > 0) {
        counters.skippedDrifted++;
        warn(
          `   ⚠️  Skipping problem ${problem.id} ("${problem.name}"): its holds no longer match the climb rows it ` +
            `already owns (${driftedUuids.join(', ')}) at layout ${layoutId}. Inserting would duplicate the climb ` +
            `and redirect the existing rows' ticks. Reconcile those rows by hand, then re-run this import.`,
        );
        continue;
      }
    } else {
      // The holds matched an existing row, so owning rows is normally just the
      // legacy import of this same problem (owned uuid === matched uuid) and
      // merging in place is correct. What is NOT correct is merging when one of
      // the owned uuids is a DIFFERENT live climb row: the alias rows below
      // would repoint it — and its ticks — at the row we matched, while it
      // stays listed. See hijackedClimbUuidsForProblem.
      const hijackedUuids = hijackedClimbUuidsForProblem({
        problemId: problem.id,
        angles,
        resolvedUuid: resolved.uuid,
        existingClimbUuids,
        canonicalByAlias,
      });
      if (hijackedUuids.length > 0) {
        counters.skippedHijacked++;
        warn(
          `   ⚠️  Skipping problem ${problem.id} ("${problem.name}"): its holds match climb ${resolved.uuid}, but the ` +
            `problem also owns live climb rows (${hijackedUuids.join(', ')}) that are not that climb and do not ` +
            `already redirect to it. Merging would repoint those rows — and their ticks — at ${resolved.uuid} while ` +
            `they stay listed. Reconcile them by hand, then re-run this import.`,
        );
        continue;
      }
    }

    // Two DISTINCT problems in this file can share holds without either one
    // matching the database (both brand new). They resolve to different
    // id-based uuids, so bestByUuid alone would insert BOTH — and every later
    // run then sees two listed rows on one fingerprint and skips the pair as
    // ambiguous, permanently. Collapse them onto the uuid this batch already
    // staged for those holds; which problem's data survives is still
    // isBetterCatalogClimb's call, made by resolveIncumbentReplacement below.
    let uuid = resolved.uuid;
    if (!resolved.matched) {
      const fingerprintKey = catalogFingerprintKey(mapped.layoutId, mapped.holdFingerprint);
      const stagedUuid = stagedUuidByFingerprint.get(fingerprintKey);
      if (stagedUuid === undefined) {
        stagedUuidByFingerprint.set(fingerprintKey, uuid);
      } else if (stagedUuid !== uuid) {
        counters.foldedInBatch++;
        uuid = stagedUuid;
      }
    }

    // Record the aliases before the dedupe below: when two problems collapse
    // onto one climb (same holds) we drop the weaker problem's data, but we
    // still want BOTH problem ids to resolve to the survivor. The self-alias
    // lets resolveCanonicalClimbUuid hit; the id-based alias (added whenever the
    // climb's canonical uuid isn't this problem's own) makes the climb
    // addressable by its MoonBoard problem id; the per-angle legacy aliases keep
    // the personal-logbook importer's `moonboard:{id}:{angle}` lookup resolving.
    for (const aliasRow of catalogAliasRows({
      problemId: problem.id,
      angles: mapped.stats.map((stat) => stat.angle),
      canonicalUuid: uuid,
    })) {
      aliasByUuid.set(aliasRow.aliasUuid, {
        boardType: 'moonboard',
        aliasUuid: aliasRow.aliasUuid,
        canonicalUuid: aliasRow.canonicalUuid,
        source: 'moonboard-catalog-import',
      });
    }

    const incumbent = bestByUuid.get(uuid);
    const decision = resolveIncumbentReplacement(uuid, mapped, incumbent);
    if (!decision.accept) continue;
    if (!incumbent) {
      if (resolved.matched) counters.matched++;
      else counters.inserted++;
    }
    bestByUuid.set(uuid, mapped);

    climbByUuid.set(uuid, {
      uuid,
      boardType: 'moonboard',
      layoutId: mapped.layoutId,
      setterId: null,
      setterUsername: mapped.setterUsername,
      name: mapped.name,
      description: mapped.description,
      hsm: null,
      edgeLeft: null,
      edgeRight: null,
      edgeBottom: null,
      edgeTop: null,
      // Angle-agnostic identity (see the importer's module header). Consumers
      // that resolve difficultyName by joining board_climb_stats at the climb's
      // own angle handle the null via climbStatsEffectiveAngleSql
      // (packages/backend/src/db/queries/util/climb-stats-join.ts): when
      // climbs.angle is null they fall back to the climb's most-ascended
      // stats row (lower angle wins ties). Formerly tracked as #4220,
      // fixed on main before this importer landed.
      angle: null,
      framesCount: 1,
      framesPace: 0,
      frames: mapped.frames,
      isDraft: false,
      isListed: true,
      createdAt: mapped.createdAt,
      synced: true,
      syncError: null,
      userId: null,
      holdFingerprint: mapped.holdFingerprint,
      characteristics: mapped.characteristics,
    });

    // Clear the beaten incumbent's stale batch-map entries (see
    // resolveIncumbentReplacement's doc comment for why this is needed).
    for (const key of decision.staleStatKeys) {
      statsByUuidAngle.delete(key);
    }
    for (const key of decision.staleHoldKeys) {
      holdsByKey.delete(key);
    }

    for (const stat of mapped.stats) {
      statsByUuidAngle.set(statsBatchKey(uuid, stat.angle), {
        boardType: 'moonboard',
        climbUuid: uuid,
        angle: stat.angle,
        displayDifficulty: stat.difficultyId ?? null,
        benchmarkDifficulty: stat.isBenchmark && stat.difficultyId !== undefined ? stat.difficultyId : null,
        // MoonBoard's community-repeat count is this board's upstream source.
        // Seed the total too (a fresh row has no Boardsesh ticks yet); the tick
        // recompute later adds boardsesh_ascensionist_count on top of upstream.
        upstreamAscensionistCount: stat.ascensionistCount,
        ascensionistCount: stat.ascensionistCount,
        difficultyAverage: stat.difficultyId ?? null,
        qualityAverage: stat.qualityAverage,
        // The manufacturer average also seeds upstream_quality_average (the
        // blend's upstream term). On a fresh INSERT quality_average == this
        // value because no Boardsesh votes exist yet; on conflict it re-blends.
        upstreamQualityAverage: stat.qualityAverage,
        qualityNormalized: true,
        faUsername: null,
        faAt: null,
        // MoonBoard catalog import is this board's upstream stats source.
        upstreamSyncedAt,
      });
    }

    for (const hold of mapped.holds) {
      holdsByKey.set(holdsBatchKey(uuid, hold.holdId), {
        boardType: 'moonboard',
        climbUuid: uuid,
        holdId: hold.holdId,
        frameNumber: 0,
        holdState: hold.holdState,
      });
    }
  }

  return {
    climbs: [...climbByUuid.values()],
    stats: [...statsByUuidAngle.values()],
    holds: [...holdsByKey.values()],
    aliases: [...aliasByUuid.values()],
    withdrawnClimbUuids: [...withdrawnUuids].filter((uuid) => !climbByUuid.has(uuid)),
    withdrawnSamples,
    counters,
    unmappedGrades,
  };
}
