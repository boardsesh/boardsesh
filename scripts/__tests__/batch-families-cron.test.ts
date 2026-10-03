/// <reference types="node" />

/**
 * The batch families and the GitHub Actions workflows they replace must fire at
 * the same minute while both exist: the cutover enables a family, waits for
 * three green ledger rows, then deletes the workflow's `schedule:` in its own
 * PR (docs/background-workers.md, "Batch families"). A PR that changes either
 * cron, or deletes a workflow schedule, has to update this pin. `cutOver`
 * marks a family whose workflow schedule is gone: the family alone owns it.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { exportBoardSnapshotsFamily } from '../../packages/backend/src/workers/families/export-board-snapshots';
import { refreshClimbGradesFamily } from '../../packages/backend/src/workers/families/refresh-climb-grades';
import { refreshClimbNeighborsFamily } from '../../packages/backend/src/workers/families/refresh-climb-neighbors';
import { refreshHoldFeaturesFamily } from '../../packages/backend/src/workers/families/refresh-hold-features';
import { refreshMoonboardAngleEstimatesFamily } from '../../packages/backend/src/workers/families/refresh-moonboard-angle-estimates';
import { refreshMoonboardWideAngleEstimatesFamily } from '../../packages/backend/src/workers/families/refresh-moonboard-wide-angle-estimates';
import { refreshRecommendationsFamily } from '../../packages/backend/src/workers/families/refresh-recommendations';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Workflow = { on: { schedule?: Array<{ cron: string }>; workflow_dispatch?: unknown } };

function workflow(name: string): Workflow {
  return parse(readFileSync(resolve(REPO_ROOT, '.github/workflows', name), 'utf8')) as Workflow;
}

const PINS = [
  {
    family: refreshRecommendationsFamily,
    workflow: 'refresh-recommendations.yml',
    cutOver: true,
    crons: ['0 6 * * *'],
  },
  { family: refreshHoldFeaturesFamily, workflow: 'refresh-hold-features.yml', cutOver: true, crons: ['15 6 * * *'] },
  { family: refreshClimbGradesFamily, workflow: 'refresh-climb-grades.yml', cutOver: true, crons: ['30 6 * * *'] },
  // The workflow runs a matrix job per board; the family fans out one job per board.
  {
    family: refreshClimbNeighborsFamily,
    workflow: 'refresh-climb-neighbors.yml',
    cutOver: true,
    crons: ['45 6 * * *'],
  },
  // The nightly identity/gzip/catalogue export, then the 15-minute live scan.
  {
    family: exportBoardSnapshotsFamily,
    workflow: 'export-board-snapshots.yml',
    cutOver: true,
    crons: ['15 7 * * *', '7,22,37,52 * * * *'],
  },
  {
    family: refreshMoonboardAngleEstimatesFamily,
    workflow: 'refresh-moonboard-angle-estimates.yml',
    cutOver: false,
    crons: ['0 8 * * 1'],
  },
  {
    family: refreshMoonboardWideAngleEstimatesFamily,
    workflow: 'refresh-moonboard-wide-angle-estimates.yml',
    cutOver: false,
    crons: ['30 8 * * 1'],
  },
] as const;

describe('batch family crons', () => {
  it.each(PINS)(
    '$family.name fires at $crons UTC; $workflow cut over: $cutOver',
    ({ family, workflow: name, cutOver, crons }) => {
      const schedules = family.schedules ?? [];
      expect(schedules.map((schedule) => schedule.cron)).toEqual(crons);
      expect(schedules.every((schedule) => (schedule.tz ?? 'UTC') === 'UTC')).toBe(true);
      const { on } = workflow(name);
      // Before the cutover both fire at the same minute; after it only the family does.
      if (cutOver) expect(on).not.toHaveProperty('schedule');
      else expect(on.schedule?.map((entry) => entry.cron)).toEqual(crons);
      // Cutover keeps the manual trigger for backfills and dry runs.
      expect(on).toHaveProperty('workflow_dispatch');
    },
  );
});
