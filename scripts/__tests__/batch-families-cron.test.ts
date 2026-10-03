/// <reference types="node" />

/**
 * A scheduled batch family and its GitHub workflow must fire at the same UTC
 * minute while both are enabled. After the snapshot owner cutover, the batch
 * family owns its schedule while Actions keeps only the manual R2 rehearsal.
 * A PR that changes either cron has to update this pin.
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
  { family: refreshRecommendationsFamily, workflow: 'refresh-recommendations.yml', crons: ['0 6 * * *'] },
  { family: refreshHoldFeaturesFamily, workflow: 'refresh-hold-features.yml', crons: ['15 6 * * *'] },
  { family: refreshClimbGradesFamily, workflow: 'refresh-climb-grades.yml', crons: ['30 6 * * *'] },
  // The workflow runs a matrix job per board; the family fans out one job per board.
  { family: refreshClimbNeighborsFamily, workflow: 'refresh-climb-neighbors.yml', crons: ['45 6 * * *'] },
  {
    family: refreshMoonboardAngleEstimatesFamily,
    workflow: 'refresh-moonboard-angle-estimates.yml',
    crons: ['0 8 * * 1'],
  },
  {
    family: refreshMoonboardWideAngleEstimatesFamily,
    workflow: 'refresh-moonboard-wide-angle-estimates.yml',
    crons: ['30 8 * * 1'],
  },
] as const;

describe('batch family crons', () => {
  it('keeps snapshot crons solely on the homelab worker after owner cutover', () => {
    expect(exportBoardSnapshotsFamily.schedules?.map((schedule) => schedule.cron)).toEqual([
      '15 7 * * *',
      '7,22,37,52 0-6,8-23 * * *',
    ]);
    const { on } = workflow('export-board-snapshots.yml');
    expect(on).not.toHaveProperty('schedule');
    expect(on).toHaveProperty('workflow_dispatch');
  });
  it.each(PINS)('$workflow and its family fire at $crons UTC', ({ family, workflow: name, crons }) => {
    const schedules = family.schedules ?? [];
    expect(schedules.map((schedule) => schedule.cron)).toEqual(crons);
    expect(schedules.every((schedule) => (schedule.tz ?? 'UTC') === 'UTC')).toBe(true);
    const { on } = workflow(name);
    expect(on.schedule?.map((entry) => entry.cron)).toEqual(crons);
    // Cutover keeps the manual trigger for backfills and dry runs.
    expect(on).toHaveProperty('workflow_dispatch');
  });
});
