/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `vp` is not installed by `bun install` — it is a separate toolchain that
 * `voidzero-dev/setup-vp` puts on PATH. A job that runs `vp` without that step
 * dies on `vp: command not found`.
 *
 * That failure is nastier than it looks in the two jobs that carry production
 * credentials: `deploy-cloudflare` had already been handed the Cloudflare token
 * by the Production environment before the step died, so the run reads as a
 * credentials or permissions problem when it is a missing binary. It shipped
 * that way in #3837 and failed on the first real deploy (run 32852243129).
 *
 * The pairing is invisible at review time — the `uses:` step and the `run:` line
 * can be forty lines apart — so it is pinned here instead.
 */

const WORKFLOW_PATHS = ['.github/workflows/production-deploy.yml', '.github/workflows/ci.yml'] as const;

const SETUP_VP_ACTION = 'voidzero-dev/setup-vp';

/**
 * `vp` invoked as a command, not the two-letter sequence appearing inside a
 * word, a path, or a URL. Anchored on the subcommands the repo actually uses so
 * a stray "vp" in prose can't trip it.
 */
const VP_INVOCATION = /(^|[\s;&|(])vp\s+(run|test|check|fmt|lint|exec)\b/;

/** Strip full-line comments so a `# ... vp run ...` note isn't read as an invocation. */
function withoutCommentLines(source: string): string[] {
  return source.split('\n').filter((line) => !line.trimStart().startsWith('#'));
}

/**
 * Split a workflow into its top-level jobs. Jobs sit at indentation 2 under a
 * column-0 `jobs:` key; a job's block runs until the next line at indentation
 * <= 2 that isn't blank.
 */
function jobBlocks(source: string): Map<string, string[]> {
  const lines = withoutCommentLines(source);
  const jobsIndex = lines.findIndex((line) => line === 'jobs:');
  if (jobsIndex < 0) throw new Error('workflow has no top-level `jobs:` key');

  const blocks = new Map<string, string[]>();
  let currentName: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines.slice(jobsIndex + 1)) {
    const jobHeader = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobHeader) {
      if (currentName) blocks.set(currentName, currentLines);
      currentName = jobHeader[1];
      currentLines = [];
      continue;
    }
    // A non-blank line back at column 0 ends the jobs mapping entirely.
    if (line.trim() && !line.startsWith(' ')) break;
    if (currentName) currentLines.push(line);
  }
  if (currentName) blocks.set(currentName, currentLines);

  return blocks;
}

describe.each(WORKFLOW_PATHS)('%s', (workflowPath) => {
  const source = readFileSync(workflowPath, 'utf8');
  const jobs = jobBlocks(source);

  it('parses into jobs at all', () => {
    // Guard the guard: a parser that silently found nothing would make every
    // assertion below vacuously true — exactly the failure mode that let a
    // previous YAML-regex guard sit green while inert.
    expect(jobs.size).toBeGreaterThan(3);
  });

  it('installs the vp toolchain in every job that runs vp', () => {
    const missing: string[] = [];

    for (const [jobName, jobLines] of jobs) {
      const runsVp = jobLines.some((line) => VP_INVOCATION.test(line));
      if (!runsVp) continue;
      const installsVp = jobLines.some((line) => line.includes(SETUP_VP_ACTION));
      if (!installsVp) missing.push(jobName);
    }

    expect(missing, `jobs run \`vp\` without \`${SETUP_VP_ACTION}\`: ${missing.join(', ')}`).toEqual([]);
  });

  it('finds at least one job that actually runs vp', () => {
    // Otherwise the assertion above passes by never entering its loop.
    const vpJobs = [...jobs].filter(([, jobLines]) => jobLines.some((line) => VP_INVOCATION.test(line)));
    expect(vpJobs.length).toBeGreaterThan(0);
  });
});

describe('VP_INVOCATION', () => {
  it('matches the ways this repo invokes vp', () => {
    for (const line of [
      '        run: vp run cf:apply -- --apply',
      '        run: vp test run --project scripts',
      '          vp check --fix',
      '        run: bun install && vp run typecheck',
    ]) {
      expect(VP_INVOCATION.test(line), line).toBe(true);
    }
  });

  it('does not match vp inside a word, path, or URL', () => {
    for (const line of [
      '        run: node scripts/vp-helper.mjs',
      '      - uses: voidzero-dev/setup-vp@v1',
      '        run: echo "https://viteplus.dev/vp run"',
      '        run: ./bin/myvp run something',
    ]) {
      expect(VP_INVOCATION.test(line), line).toBe(false);
    }
  });
});
