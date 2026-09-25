/// <reference types="node" />

/**
 * CI queue-time report: how long jobs waited for a runner, and how long they ran.
 *
 *   vp exec tsx scripts/ci/queue-report.ts [--days 7] [--repo owner/name]
 *     [--workflows ci.yml,production-deploy.yml] [--per-workflow 40] [--json]
 *
 * For each workflow it samples up to --per-workflow completed runs created in
 * the last --days days, fetches their jobs through `gh api`, and reports:
 *
 *   queue    = job.started_at - job.created_at    (waiting for a free runner slot)
 *   duration = job.completed_at - job.started_at  (runner time actually used)
 *
 * Only jobs that concluded success / failure / cancelled count as "ran"; skipped
 * jobs are counted in their own column and carry no timings. Matrix legs share a
 * row: ` (1, 2)`-style suffixes are stripped. All numbers are minutes. totalMin is
 * the summed duration (roughly the runner minutes the job used).
 *
 * Baseline, 2026-09-18..25, on the Free plan's 20 concurrent job slots:
 * ci.yml jobs median queue 0.6 min, p90 10.9, max 36; production-deploy max
 * queue 12 min; OTA preview `gate` median queue 4.1 min. Re-run after the Team
 * upgrade (60 slots) and compare against those.
 */
import { execFileSync } from 'node:child_process';

const DEFAULT_WORKFLOWS = [
  'ci.yml',
  'production-deploy.yml',
  'mobile-ota-production.yml',
  'mobile-ota-preview.yml',
  'ios-rn-ci.yml',
  'android-pr-rn.yml',
];
const RAN_CONCLUSIONS = new Set(['success', 'failure', 'cancelled']);

interface Options {
  days: number;
  repo: string;
  workflows: string[];
  perWorkflow: number;
  json: boolean;
}

interface JobSample {
  workflow: string;
  name: string;
  labels: string;
  skipped: boolean;
  queueMinutes: number;
  durationMinutes: number;
}

interface StatsRow {
  key: string;
  ran: number;
  skipped: number;
  variants: number;
  medQ: number;
  p90Q: number;
  maxQ: number;
  medDur: number;
  p90Dur: number;
  totalMin: number;
}

function fail(message: string): never {
  process.stderr.write(`queue-report: ${message}\n`);
  process.exit(1);
}

function parsePositiveInt(flag: string, raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${flag} needs a positive integer, got "${raw ?? ''}"`);
  return parsed;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    days: 7,
    repo: 'boardsesh/boardsesh',
    workflows: DEFAULT_WORKFLOWS,
    perWorkflow: 40,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    switch (flag) {
      case '--days':
        options.days = parsePositiveInt(flag, next);
        index += 1;
        break;
      case '--repo':
        if (!next || !/^[\w.-]+\/[\w.-]+$/.test(next)) fail(`--repo needs owner/name, got "${next ?? ''}"`);
        options.repo = next;
        index += 1;
        break;
      case '--workflows':
        if (!next) fail('--workflows needs a comma-separated list of workflow files');
        options.workflows = next
          .split(',')
          .map((file) => file.trim())
          .filter((file) => file.length > 0);
        index += 1;
        break;
      case '--per-workflow':
        options.perWorkflow = Math.min(parsePositiveInt(flag, next), 100);
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        process.stdout.write(
          'Usage: vp exec tsx scripts/ci/queue-report.ts [--days N] [--repo owner/name] [--workflows a.yml,b.yml] [--per-workflow N] [--json]\n',
        );
        process.exit(0);
        break;
      default:
        fail(`unknown flag "${flag}" (try --help)`);
    }
  }
  return options;
}

function ensureGh(): void {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
  } catch {
    fail('the GitHub CLI `gh` is not installed or not on PATH. Install it from https://cli.github.com/');
  }
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
  } catch {
    fail('`gh` is not authenticated. Run `gh auth login` first.');
  }
}

function ghApi(path: string, jq?: string): string {
  const args = ['api', path];
  if (jq) args.push('--jq', jq);
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`gh api ${path} failed: ${detail}`);
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

function stringField(record: Record<string, unknown>, field: string): string | null {
  const fieldValue = record[field];
  return typeof fieldValue === 'string' ? fieldValue : null;
}

function minutesBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, (endMs - startMs) / 60000);
}

function baseJobName(name: string): string {
  return name.replace(/\s*\([^()]*\)\s*$/, '').trim() || name;
}

function collectWorkflow(options: Options, workflow: string, sinceDate: string): JobSample[] {
  const query = `per_page=${options.perWorkflow}&status=completed&created=${encodeURIComponent(`>=${sinceDate}`)}`;
  const idsOutput = ghApi(`repos/${options.repo}/actions/workflows/${workflow}/runs?${query}`, '.workflow_runs[].id');
  const runIds = idsOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));

  const samples: JobSample[] = [];
  for (const runId of runIds) {
    const parsed: unknown = JSON.parse(ghApi(`repos/${options.repo}/actions/runs/${runId}/jobs?per_page=100`));
    if (!isRecord(parsed) || !Array.isArray(parsed.jobs)) continue;
    for (const job of parsed.jobs) {
      if (!isRecord(job)) continue;
      const name = stringField(job, 'name') ?? '(unnamed)';
      const conclusion = stringField(job, 'conclusion');
      const labels = Array.isArray(job.labels)
        ? job.labels.filter((label): label is string => typeof label === 'string').join(',')
        : '';
      if (conclusion === 'skipped') {
        samples.push({ workflow, name, labels, skipped: true, queueMinutes: 0, durationMinutes: 0 });
        continue;
      }
      if (!conclusion || !RAN_CONCLUSIONS.has(conclusion)) continue;
      const createdAt = stringField(job, 'created_at');
      const startedAt = stringField(job, 'started_at');
      const completedAt = stringField(job, 'completed_at');
      const queueMinutes = minutesBetween(createdAt, startedAt);
      const durationMinutes = minutesBetween(startedAt, completedAt);
      if (queueMinutes === null || durationMinutes === null) continue;
      samples.push({ workflow, name, labels, skipped: false, queueMinutes, durationMinutes });
    }
  }
  return samples;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarise(key: string, samples: JobSample[]): StatsRow {
  const ran = samples.filter((sample) => !sample.skipped);
  const queues = ran.map((sample) => sample.queueMinutes).sort((a, b) => a - b);
  const durations = ran.map((sample) => sample.durationMinutes).sort((a, b) => a - b);
  return {
    key,
    ran: ran.length,
    skipped: samples.length - ran.length,
    variants: new Set(samples.map((sample) => sample.name)).size,
    medQ: percentile(queues, 0.5),
    p90Q: percentile(queues, 0.9),
    maxQ: queues.length > 0 ? queues[queues.length - 1] : 0,
    medDur: percentile(durations, 0.5),
    p90Dur: percentile(durations, 0.9),
    totalMin: durations.reduce((sum, minutes) => sum + minutes, 0),
  };
}

function groupRows(samples: JobSample[], keyOf: (sample: JobSample) => string): StatsRow[] {
  const groups = new Map<string, JobSample[]>();
  for (const sample of samples) {
    const key = keyOf(sample);
    const group = groups.get(key);
    if (group) group.push(sample);
    else groups.set(key, [sample]);
  }
  return [...groups.entries()]
    .map(([key, group]) => summarise(key, group))
    .sort((a, b) => b.p90Q - a.p90Q || b.maxQ - a.maxQ);
}

function renderTable(title: string, keyHeader: string, rows: StatsRow[], showLegs: boolean): string {
  const header = [keyHeader, 'ran', 'skipped', 'medQ', 'p90Q', 'maxQ', 'medDur', 'p90Dur', 'totalMin'];
  const body = rows.map((row) => [
    showLegs && row.variants > 1 ? `${row.key} [${row.variants} legs]` : row.key,
    String(row.ran),
    String(row.skipped),
    row.medQ.toFixed(2),
    row.p90Q.toFixed(2),
    row.maxQ.toFixed(2),
    row.medDur.toFixed(2),
    row.p90Dur.toFixed(2),
    row.totalMin.toFixed(2),
  ]);
  const widths = header.map((cell, column) => Math.max(cell.length, ...body.map((line) => line[column].length)));
  const format = (cells: string[]): string =>
    cells
      .map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])))
      .join('  ');
  const lines = [`## ${title}`, format(header), widths.map((width) => '-'.repeat(width)).join('  ')];
  if (body.length === 0) lines.push('(no completed jobs in window)');
  for (const line of body) lines.push(format(line));
  return lines.join('\n');
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  ensureGh();
  const sinceDate = new Date(Date.now() - options.days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const perWorkflow = options.workflows.map((workflow) => ({
    workflow,
    samples: collectWorkflow(options, workflow, sinceDate),
  }));
  const allSamples = perWorkflow.flatMap((entry) => entry.samples);
  const labelRows = groupRows(allSamples, (sample) => sample.labels || '(none)');
  const total = summarise('total', allSamples);

  if (options.json) {
    const report = {
      repo: options.repo,
      since: sinceDate,
      days: options.days,
      perWorkflow: options.perWorkflow,
      workflows: perWorkflow.map((entry) => ({
        workflow: entry.workflow,
        jobs: groupRows(entry.samples, (sample) => baseJobName(sample.name)),
      })),
      labels: labelRows,
      total,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const sections = [
    `Queue report for ${options.repo}: runs created since ${sinceDate}, up to ${options.perWorkflow} per workflow. Minutes.`,
  ];
  for (const entry of perWorkflow) {
    sections.push(
      renderTable(
        entry.workflow,
        'job',
        groupRows(entry.samples, (sample) => baseJobName(sample.name)),
        true,
      ),
    );
  }
  sections.push(renderTable('by runner label', 'labels', labelRows, false));
  sections.push(
    `Total: ${total.ran} jobs ran, ${total.skipped} skipped; queue med ${total.medQ.toFixed(2)} / p90 ${total.p90Q.toFixed(2)} / max ${total.maxQ.toFixed(2)}; duration med ${total.medDur.toFixed(2)} / p90 ${total.p90Dur.toFixed(2)}; ${total.totalMin.toFixed(2)} runner min.`,
  );
  process.stdout.write(`${sections.join('\n\n')}\n`);
}

main();
