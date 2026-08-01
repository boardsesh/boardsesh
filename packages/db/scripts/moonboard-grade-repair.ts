import { HOLDSETUP_TO_LAYOUT, catalogProblemToClimbs, type MoonBoardCatalogFile } from './moonboard-catalog-helpers.js';

export const MOONBOARD_8C_DIFFICULTY_IDS = [32, 33] as const;

const MOONBOARD_8C_DIFFICULTY_ID_SET = new Set<number>(MOONBOARD_8C_DIFFICULTY_IDS);
const APPLY_FLAG = '--apply';
const ARG_SEPARATOR = '--';

export function parseMoonBoard8cRepairArgs(args: readonly string[]): { apply: boolean; catalogPath: string } {
  const meaningfulArgs = args.filter((argument) => argument !== ARG_SEPARATOR);
  let apply = false;
  let catalogPath: string | null = null;

  for (const argument of meaningfulArgs) {
    if (argument === APPLY_FLAG) {
      apply = true;
      continue;
    }
    if (argument.startsWith('--')) throw new Error(`Unknown argument: ${argument}`);
    if (catalogPath !== null) throw new Error(`Unexpected second catalog path: ${argument}`);
    catalogPath = argument;
  }

  if (catalogPath === null) {
    throw new Error(
      'Catalog path required. Usage: vp run db:repair-moonboard-8c-grades -- /path/to/app-catalog [--apply]',
    );
  }
  return { apply, catalogPath };
}

export type MoonBoardCatalogSource = {
  fileName: string;
  dump: MoonBoardCatalogFile;
};

export type MoonBoardGradeRepairCandidate = {
  sourceUuid: string;
  sourceProblemId: number;
  sourceFileName: string;
  layoutId: number;
  angle: number;
  name: string;
  sourceGrade: string;
  difficultyId: number;
  isBenchmark: boolean;
  ascensionistCount: number;
};

export type MoonBoardGradeRepairTarget = MoonBoardGradeRepairCandidate & {
  canonicalUuid: string;
  sourceProblemIds: number[];
  sourceUuids: string[];
};

export type MoonBoardAliasProblem = {
  sourceUuid: string;
  path: string[];
};

export type MoonBoardStoredGradeRow = {
  climbUuid: string;
  statsAngle: number;
  climbAngle: number | null;
  layoutId: number;
  userId: string | null;
  isDraft: boolean | null;
  isListed: boolean | null;
  displayDifficulty: number | null;
  benchmarkDifficulty: number | null;
  difficultyAverage: number | null;
};

export type MoonBoardGradeRepairUpdate = {
  target: MoonBoardGradeRepairTarget;
  before: MoonBoardStoredGradeRow;
  fillDisplayDifficulty: boolean;
  fillBenchmarkDifficulty: boolean;
  fillDifficultyAverage: boolean;
};

export type MoonBoardGradeRepairSkip = {
  target: MoonBoardGradeRepairTarget;
  reason: string;
};

export type MoonBoardGradeRepairPlan = {
  updates: MoonBoardGradeRepairUpdate[];
  unchanged: MoonBoardGradeRepairTarget[];
  skipped: MoonBoardGradeRepairSkip[];
};

export type MoonBoardGradeRepairStore = {
  loadRows: (targets: readonly MoonBoardGradeRepairTarget[]) => Promise<MoonBoardStoredGradeRow[]>;
  applyUpdate: (update: MoonBoardGradeRepairUpdate) => Promise<boolean>;
};

export type MoonBoardGradeRepairExecution = {
  plan: MoonBoardGradeRepairPlan;
  appliedRows: number;
  verifiedPlan: MoonBoardGradeRepairPlan | null;
};

export function extractMoonBoard8cCandidates(sources: readonly MoonBoardCatalogSource[]): {
  candidates: MoonBoardGradeRepairCandidate[];
  unknownHoldsetups: { fileName: string; holdsetup: number }[];
} {
  const candidates: MoonBoardGradeRepairCandidate[] = [];
  const unknownHoldsetups: { fileName: string; holdsetup: number }[] = [];

  for (const { fileName, dump } of sources) {
    const layoutId = HOLDSETUP_TO_LAYOUT[dump.holdsetup];
    if (layoutId === undefined) {
      unknownHoldsetups.push({ fileName, holdsetup: dump.holdsetup });
      continue;
    }

    for (const problem of dump.problems) {
      for (const mapped of catalogProblemToClimbs(problem, layoutId)) {
        if (mapped.difficultyId === undefined || !MOONBOARD_8C_DIFFICULTY_ID_SET.has(mapped.difficultyId)) continue;
        candidates.push({
          sourceUuid: mapped.uuid,
          sourceProblemId: problem.id,
          sourceFileName: fileName,
          layoutId,
          angle: mapped.angle,
          name: mapped.name,
          sourceGrade: mapped.sourceGrade.trim().toUpperCase(),
          difficultyId: mapped.difficultyId,
          isBenchmark: mapped.isBenchmark,
          ascensionistCount: mapped.ascensionistCount,
        });
      }
    }
  }

  return { candidates, unknownHoldsetups };
}

export function resolveTerminalMoonBoardAlias(
  sourceUuid: string,
  canonicalByAlias: ReadonlyMap<string, string>,
): { canonicalUuid: string | null; path: string[] } {
  const path: string[] = [];
  const visited = new Set<string>();
  let currentUuid = sourceUuid;

  while (!visited.has(currentUuid)) {
    visited.add(currentUuid);
    path.push(currentUuid);
    const nextUuid = canonicalByAlias.get(currentUuid);
    if (nextUuid === undefined || nextUuid === currentUuid) return { canonicalUuid: currentUuid, path };
    currentUuid = nextUuid;
  }

  path.push(currentUuid);
  return { canonicalUuid: null, path };
}

function candidateBeatsIncumbent(
  candidate: MoonBoardGradeRepairCandidate,
  incumbent: MoonBoardGradeRepairTarget,
): boolean {
  if (candidate.ascensionistCount !== incumbent.ascensionistCount) {
    return candidate.ascensionistCount > incumbent.ascensionistCount;
  }
  return candidate.isBenchmark && !incumbent.isBenchmark;
}

export function resolveMoonBoardGradeRepairTargets(
  candidates: readonly MoonBoardGradeRepairCandidate[],
  canonicalByAlias: ReadonlyMap<string, string>,
): { targets: MoonBoardGradeRepairTarget[]; aliasProblems: MoonBoardAliasProblem[] } {
  const targetsByKey = new Map<string, MoonBoardGradeRepairTarget>();
  const aliasProblems: MoonBoardAliasProblem[] = [];

  for (const candidate of candidates) {
    const resolution = resolveTerminalMoonBoardAlias(candidate.sourceUuid, canonicalByAlias);
    if (resolution.canonicalUuid === null) {
      aliasProblems.push({ sourceUuid: candidate.sourceUuid, path: resolution.path });
      continue;
    }

    const key = `${resolution.canonicalUuid}:${candidate.angle}`;
    const incumbent = targetsByKey.get(key);
    if (incumbent === undefined) {
      targetsByKey.set(key, {
        ...candidate,
        canonicalUuid: resolution.canonicalUuid,
        sourceProblemIds: [candidate.sourceProblemId],
        sourceUuids: [candidate.sourceUuid],
      });
      continue;
    }

    const sourceProblemIds = [...new Set([...incumbent.sourceProblemIds, candidate.sourceProblemId])].sort(
      (leftProblemId, rightProblemId) => leftProblemId - rightProblemId,
    );
    const sourceUuids = [...new Set([...incumbent.sourceUuids, candidate.sourceUuid])].sort();
    if (candidateBeatsIncumbent(candidate, incumbent)) {
      targetsByKey.set(key, {
        ...candidate,
        canonicalUuid: resolution.canonicalUuid,
        sourceProblemIds,
        sourceUuids,
      });
    } else {
      incumbent.sourceProblemIds = sourceProblemIds;
      incumbent.sourceUuids = sourceUuids;
    }
  }

  return {
    targets: [...targetsByKey.values()].sort(
      (leftTarget, rightTarget) =>
        leftTarget.canonicalUuid.localeCompare(rightTarget.canonicalUuid) || leftTarget.angle - rightTarget.angle,
    ),
    aliasProblems,
  };
}

export function planMoonBoardGradeRepairs(
  targets: readonly MoonBoardGradeRepairTarget[],
  rows: readonly MoonBoardStoredGradeRow[],
): MoonBoardGradeRepairPlan {
  const rowsByKey = new Map(rows.map((row) => [`${row.climbUuid}:${row.statsAngle}`, row]));
  const plan: MoonBoardGradeRepairPlan = { updates: [], unchanged: [], skipped: [] };

  for (const target of targets) {
    const row = rowsByKey.get(`${target.canonicalUuid}:${target.angle}`);
    if (row === undefined) {
      plan.skipped.push({ target, reason: 'no existing climb/stats row at the catalog angle' });
      continue;
    }
    if (row.layoutId !== target.layoutId || row.climbAngle !== target.angle) {
      plan.skipped.push({ target, reason: 'stored layout/angle does not match the authoritative catalog target' });
      continue;
    }
    if (row.userId !== null) {
      plan.skipped.push({ target, reason: 'stored climb is user-owned' });
      continue;
    }
    if (row.isDraft !== false) {
      plan.skipped.push({ target, reason: 'stored climb is a draft or has unknown draft state' });
      continue;
    }
    if (row.isListed !== true) {
      plan.skipped.push({ target, reason: 'stored climb is not a listed catalog climb' });
      continue;
    }

    const fillDisplayDifficulty = row.displayDifficulty === null;
    const fillBenchmarkDifficulty = target.isBenchmark && row.benchmarkDifficulty === null;
    const fillDifficultyAverage = row.difficultyAverage === null;
    if (!fillDisplayDifficulty && !fillBenchmarkDifficulty && !fillDifficultyAverage) {
      plan.unchanged.push(target);
      continue;
    }

    plan.updates.push({
      target,
      before: row,
      fillDisplayDifficulty,
      fillBenchmarkDifficulty,
      fillDifficultyAverage,
    });
  }

  return plan;
}

export async function executeMoonBoardGradeRepair(
  targets: readonly MoonBoardGradeRepairTarget[],
  store: MoonBoardGradeRepairStore,
  apply: boolean,
): Promise<MoonBoardGradeRepairExecution> {
  const plan = planMoonBoardGradeRepairs(targets, await store.loadRows(targets));
  if (!apply) return { plan, appliedRows: 0, verifiedPlan: null };

  for (const update of plan.updates) {
    const applied = await store.applyUpdate(update);
    if (!applied) {
      throw new Error(
        `Concurrent change prevented the guarded grade repair for ${update.target.canonicalUuid} at ${update.target.angle}°`,
      );
    }
  }

  const verifiedPlan = planMoonBoardGradeRepairs(targets, await store.loadRows(targets));
  if (verifiedPlan.updates.length > 0) {
    throw new Error(`Post-apply verification still found ${verifiedPlan.updates.length} repairable grade rows`);
  }
  return { plan, appliedRows: plan.updates.length, verifiedPlan };
}
