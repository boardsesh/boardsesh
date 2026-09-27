/// <reference types="node" />

/**
 * The batch families and the GitHub Actions workflows they replace must fire at
 * the same minute while both exist: the cutover enables a family, waits for
 * three green ledger rows, then deletes the workflow's `schedule:` in its own
 * PR (docs/background-workers.md, "Batch families"). A PR that changes either
 * cron, or deletes a workflow schedule, has to update this pin.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { refreshClimbGradesFamily } from '../../packages/backend/src/workers/families/refresh-climb-grades';
import { refreshHoldFeaturesFamily } from '../../packages/backend/src/workers/families/refresh-hold-features';
import { refreshRecommendationsFamily } from '../../packages/backend/src/workers/families/refresh-recommendations';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Workflow = { on: { schedule?: Array<{ cron: string }>; workflow_dispatch?: unknown } };

function workflow(name: string): Workflow {
  return parse(readFileSync(resolve(REPO_ROOT, '.github/workflows', name), 'utf8')) as Workflow;
}

const PINS = [
  { family: refreshRecommendationsFamily, workflow: 'refresh-recommendations.yml', cron: '0 6 * * *' },
  { family: refreshHoldFeaturesFamily, workflow: 'refresh-hold-features.yml', cron: '15 6 * * *' },
  { family: refreshClimbGradesFamily, workflow: 'refresh-climb-grades.yml', cron: '30 6 * * *' },
] as const;

describe('batch family crons', () => {
  it.each(PINS)('$workflow and its family fire at $cron UTC', ({ family, workflow: name, cron }) => {
    const schedules = family.schedules ?? [];
    expect(schedules.map((schedule) => schedule.cron)).toEqual([cron]);
    expect(schedules.every((schedule) => (schedule.tz ?? 'UTC') === 'UTC')).toBe(true);
    const { on } = workflow(name);
    expect(on.schedule?.map((entry) => entry.cron)).toEqual([cron]);
    // Cutover keeps the manual trigger for backfills and dry runs.
    expect(on).toHaveProperty('workflow_dispatch');
  });
});
