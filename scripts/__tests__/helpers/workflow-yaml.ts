/// <reference types="node" />

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal workflow-YAML readers shared by the specs that pin invisible pairings
 * in `.github/workflows` (a `uses:` step and the `run:` forty lines below it, a
 * `runs-on` label and the secrets the job is allowed to see).
 *
 * Deliberately string-based rather than a YAML parse: several of these specs
 * assert on things a parse throws away — that an expression is *byte*-identical
 * everywhere, that a value is a literal rather than an expression, that a line
 * is commented out. Extracted from ci-vp-toolchain.test.ts, which had the first
 * copy.
 */

/** Every `.yml`/`.yaml` under `.github`, recursively. */
export function githubYamlPaths(directory = '.github'): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return githubYamlPaths(entryPath);
    return entry.name.endsWith('.yml') || entry.name.endsWith('.yaml') ? [entryPath] : [];
  });
}

/** Strip full-line comments so a commented-out example isn't read as live config. */
export function withoutCommentLines(source: string): string[] {
  return source.split('\n').filter((line) => !line.trimStart().startsWith('#'));
}

/**
 * Split a workflow into its top-level jobs. Jobs sit at indentation 2 under a
 * column-0 `jobs:` key; a job's block runs until the next line at indentation
 * <= 2 that isn't blank.
 */
export function jobBlocks(source: string): Map<string, string[]> {
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

/**
 * The workflow-level `env:` block: lines at indentation 2 under a column-0
 * `env:` key. Job-level env is invisible to this, which is the point — the
 * mobile fingerprint specs care specifically about the workflow-level values.
 */
export function workflowEnvLines(source: string): string[] {
  const lines = withoutCommentLines(source);
  const envIndex = lines.findIndex((line) => line === 'env:');
  if (envIndex < 0) return [];

  const collected: string[] = [];
  for (const line of lines.slice(envIndex + 1)) {
    if (!line.trim()) continue;
    if (!line.startsWith('  ')) break;
    collected.push(line);
  }
  return collected;
}

/**
 * A `runs-on:` line that resolves through `vars.CI_RUNNER_LINUX`.
 *
 * Matching on the runs-on line specifically, not on the variable name appearing
 * anywhere in the block: ci-runner-watchdog.yml reads and writes that variable
 * in its script, and it is emphatically not a routed job.
 */
export function isRoutedRunsOn(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('runs-on:') && trimmed.includes('vars.CI_RUNNER_LINUX');
}

/**
 * A `runs-on:` line that resolves through `vars.DEPLOY_RUNNER_LINUX` — the
 * SECOND routing variable, used only by production-deploy.yml's build jobs.
 *
 * It exists as its own function, and its own variable, for a reason that is
 * easy to lose: `isRoutedRunsOn` matches only `CI_RUNNER_LINUX`, so a job
 * routed through a different variable is invisible to
 * ci-self-hosted-secret-boundary.test.ts. Routing deploy work through a new
 * name would therefore leave that boundary test green while the boundary was
 * gone — exactly the silent regression its header warns about. Everything that
 * reasons about "jobs that can land on the homelab" must consider BOTH.
 */
export function isDeployRoutedRunsOn(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('runs-on:') && trimmed.includes('vars.DEPLOY_RUNNER_LINUX');
}

/**
 * True when the document has a top-level `jobs:` key, i.e. is a workflow rather
 * than a composite action, dependabot config, or issue-form template. `.github`
 * is full of those, and jobBlocks() throws on them by design.
 */
export function isWorkflow(source: string): boolean {
  return withoutCommentLines(source).includes('jobs:');
}

/**
 * Job names in `source` whose runs-on routes through the fleet variable. Returns
 * [] for non-workflow YAML so callers can scan all of `.github` freely.
 */
export function routedJobNames(source: string): string[] {
  if (!isWorkflow(source)) return [];
  return [...jobBlocks(source)].filter(([, block]) => block.some(isRoutedRunsOn)).map(([jobName]) => jobName);
}
