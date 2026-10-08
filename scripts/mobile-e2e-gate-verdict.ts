/// <reference types="node" />

/**
 * The verdict of .github/workflows/mobile-e2e-gate.yml: one line a caller can
 * rely on, a table for the step summary, and the `passed` output.
 *
 * Kept out of the workflow's YAML so the rules are tested
 * (scripts/__tests__/mobile-e2e-gate-verdict.test.ts) instead of living in
 * inline bash nobody can run. The rules:
 *
 *   - a job is `pass`, `fail`, `cancelled` or `not run`. A skipped job (the
 *     placeholder for a job that does not exist yet is one) is `not run`. It is
 *     never counted as a pass.
 *   - `passed` is true only when every BLOCKING job is `pass`. A blocking job
 *     that did not run cannot vouch for the commit, so it makes `passed` false.
 *   - the verdict job itself fails only when a blocking job failed or was
 *     cancelled. An advisory job that fails is reported and changes nothing.
 *
 * Usage (from the workflow; every input is an environment variable):
 *   GATE_JOBS    {"<job id>": "blocking" | "advisory", …}, in table order
 *   GATE_NOTES   optional, {"<job id>": "words for its Notes column"}
 *   GATE_NEEDS   the `needs` context as JSON
 *   GATE_SHA     the commit under test
 *   GATE_RUN_JOBS_FILE   optional, the run's jobs from the REST API, for durations
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type GateJobMode = 'blocking' | 'advisory';
export type GateJobState = 'pass' | 'fail' | 'cancelled' | 'not run';

export interface GateJobInput {
  id: string;
  mode: GateJobMode;
  /** The job's `result` from the `needs` context; undefined when the job is not in it. */
  result: string | undefined;
  /** Extra words for the table: a failure class, a retry that was needed. */
  detail: string;
  durationSeconds: number | null;
}

export interface GateJobVerdict extends GateJobInput {
  state: GateJobState;
}

export interface GateVerdict {
  passed: boolean;
  /** Whether the verdict job should exit non-zero. */
  blockingFailed: boolean;
  /** Whether anything at all is red, blocking or advisory. Drives the nightly Discord post. */
  anyRed: boolean;
  jobs: GateJobVerdict[];
  line: string;
  table: string;
}

export function gateJobState(result: string | undefined): GateJobState {
  if (result === 'success') return 'pass';
  if (result === 'failure') return 'fail';
  if (result === 'cancelled') return 'cancelled';
  // `skipped`, or a job missing from `needs` altogether.
  return 'not run';
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'n/a';
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

function markdownCell(content: string): string {
  return content.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
}

export function computeGateVerdict(inputs: readonly GateJobInput[], sha: string): GateVerdict {
  const jobs = inputs.map((job) => ({ ...job, state: gateJobState(job.result) }));
  const blocking = jobs.filter((job) => job.mode === 'blocking');
  const passed = blocking.every((job) => job.state === 'pass');
  const blockingFailed = blocking.some((job) => job.state === 'fail' || job.state === 'cancelled');
  const anyRed = jobs.some((job) => job.state === 'fail' || job.state === 'cancelled');

  const describe = (job: GateJobVerdict) => `${job.id}=${job.state}${job.detail ? ` (${job.detail})` : ''}`;
  const blockingPassed = blocking.filter((job) => job.state === 'pass').length;
  const line =
    `mobile-e2e-gate: passed=${passed} sha=${sha} blocking ${blockingPassed}/${blocking.length} passed` +
    `${blocking.length === 0 ? ' (nothing is blocking yet, so this vouches for nothing)' : ''}; ` +
    jobs.map(describe).join(', ');

  const table = [
    `### Mobile E2E gate at \`${sha}\``,
    '',
    `**passed=${passed}** (${blockingPassed} of ${blocking.length} blocking jobs passed)`,
    '',
    '| Job | Mode | Result | Duration | Notes |',
    '| --- | --- | --- | --- | --- |',
    ...jobs.map(
      (job) =>
        `| ${markdownCell(job.id)} | ${job.mode} | ${job.state} | ${formatDuration(job.durationSeconds)} | ${markdownCell(job.detail)} |`,
    ),
    '',
  ].join('\n');

  return { passed, blockingFailed, anyRed, jobs, line, table };
}

interface NeedsEntry {
  result?: string;
  outputs?: Record<string, string>;
}

interface RunJob {
  name: string;
  started_at: string | null;
  completed_at: string | null;
}

/**
 * How long a gate job took, from the run's job list. A job from a reusable
 * workflow is named `<caller job> / <job>`, and the whole gate gains one more
 * prefix when it is itself called, so a job belongs to gate job `id` when any
 * segment of its name is `id`. Several can match (a called workflow has several
 * jobs); the span from the first start to the last finish is the duration.
 */
export function gateJobDurationSeconds(id: string, runJobs: readonly RunJob[]): number | null {
  const spans = runJobs
    .filter((job) => job.name.split(' / ').includes(id) && job.started_at && job.completed_at)
    .map((job) => ({ start: Date.parse(job.started_at as string), end: Date.parse(job.completed_at as string) }));
  if (spans.length === 0) return null;
  const start = Math.min(...spans.map((span) => span.start));
  const end = Math.max(...spans.map((span) => span.end));
  return Math.max(0, Math.round((end - start) / 1000));
}

/**
 * The words a smoke job's outputs add to its row. The launch crash is named
 * even on a pass, because a retry that recovered it is the pattern the gate
 * wants counted.
 */
export function smokeDetail(outputs: Record<string, string>): string {
  const parts: string[] = [];
  if (outputs.failure_label) parts.push(outputs.failure_label);
  const launchCrashes = Number.parseInt(outputs.native_crash_at_launch_count ?? '0', 10) || 0;
  if (launchCrashes > 0 && outputs.failure_class !== 'native-crash-at-launch') {
    parts.push(`native crash at launch x${launchCrashes}, recovered by the fresh-boot retry`);
  } else if (launchCrashes > 1) {
    parts.push(`x${launchCrashes}`);
  }
  return parts.join('; ');
}

export function buildGateJobInputs(
  modes: Record<string, string>,
  needs: Record<string, NeedsEntry>,
  runJobs: readonly RunJob[],
  notes: Record<string, string> = {},
): GateJobInput[] {
  return Object.entries(modes).map(([id, mode]) => {
    if (mode !== 'blocking' && mode !== 'advisory') {
      throw new Error(`GATE_JOBS: ${id} must be "blocking" or "advisory" (got "${mode}")`);
    }
    const entry = needs[id];
    return {
      id,
      mode,
      result: entry?.result,
      detail: [notes[id], smokeDetail(entry?.outputs ?? {})].filter(Boolean).join('; '),
      durationSeconds: gateJobDurationSeconds(id, runJobs),
    };
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function writeOutput(name: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  // The delimiter form, so a multi-line value (the table) survives.
  const delimiter = `GATE_${randomUUID()}`;
  appendFileSync(outputPath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function evaluateGate(): number {
  const modes = JSON.parse(requireEnv('GATE_JOBS')) as Record<string, string>;
  const needs = JSON.parse(requireEnv('GATE_NEEDS')) as Record<string, NeedsEntry>;
  const notes = JSON.parse(process.env.GATE_NOTES || '{}') as Record<string, string>;
  const sha = requireEnv('GATE_SHA');
  const runJobsFile = process.env.GATE_RUN_JOBS_FILE;
  let runJobs: RunJob[] = [];
  if (runJobsFile && existsSync(runJobsFile)) {
    try {
      const parsed = JSON.parse(readFileSync(runJobsFile, 'utf8')) as { jobs: RunJob[] };
      if (!Array.isArray(parsed.jobs)) throw new Error('jobs must be an array');
      runJobs = parsed.jobs;
    } catch {
      console.warn('::warning::Cannot read optional run-job durations; reporting n/a.');
    }
  }

  const verdict = computeGateVerdict(buildGateJobInputs(modes, needs, runJobs, notes), sha);
  console.log(verdict.line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${verdict.table}\n`);
  writeOutput('passed', String(verdict.passed));
  writeOutput('any_red', String(verdict.anyRed));
  writeOutput('line', verdict.line);
  writeOutput('table', verdict.table);
  if (verdict.blockingFailed) {
    console.error('::error::A blocking job of the mobile E2E gate failed. See the table in the step summary.');
    return 1;
  }
  return 0;
}

export function main(): number {
  try {
    return evaluateGate();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const line = `mobile-e2e-gate: passed=false; verdict input error: ${reason}`;
    console.error(`::error::${line}`);
    writeOutput('passed', 'false');
    writeOutput('any_red', 'true');
    writeOutput('line', line);
    writeOutput('table', `### Mobile E2E gate\n\n**passed=false**: ${markdownCell(reason)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
