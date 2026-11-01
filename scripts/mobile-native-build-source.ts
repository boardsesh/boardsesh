/// <reference types="node" />

/** Resolve a binary's source independently of the workflow's tooling revision. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseBuildTag } from './lib/release-tags.ts';

export type NativeBuildSource = {
  schemaVersion: 1;
  platform: 'ios' | 'android';
  sourceSha: string;
  workflowSha: string;
  sourceRunId: string;
  version: string;
  buildNumber: string;
  buildTag: string;
};
export type NativeSourceRuntime = {
  readRun(runId: string): unknown;
  readArtifact(runId: string, attempt: number): unknown;
  tagCommit(tag: string): string;
  isAncestor(sha: string): boolean;
};

function fields(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('Invalid native source object.');
  return input as Record<string, unknown>;
}

export function resolveNativeBuildSource(
  runtime: NativeSourceRuntime,
  runId: string,
  repository: string,
): NativeBuildSource | null {
  if (!/^[1-9]\d*$/.test(runId)) throw new Error('A native source requires a positive run ID.');
  const run = fields(runtime.readRun(runId));
  const workflowPlatform =
    run.path === '.github/workflows/ios-testflight-rn.yml'
      ? 'ios'
      : run.path === '.github/workflows/android-apk-rn.yml'
        ? 'android'
        : null;
  if (
    !workflowPlatform ||
    run.head_branch !== 'main' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    !['push', 'workflow_dispatch'].includes(String(run.event)) ||
    fields(run.head_repository).full_name !== repository ||
    String(run.id) !== runId ||
    !Number.isSafeInteger(run.run_attempt) ||
    Number(run.run_attempt) < 1
  )
    throw new Error('Native source must come from a successful trusted main native workflow.');
  const artifact = runtime.readArtifact(runId, Number(run.run_attempt));
  if (artifact === null) return null;
  const receipt = fields(artifact);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.platform !== workflowPlatform ||
    receipt.sourceRunId !== runId ||
    receipt.workflowSha !== run.head_sha ||
    !/^[0-9a-f]{40}$/.test(String(receipt.workflowSha)) ||
    !/^[0-9a-f]{40}$/.test(String(receipt.sourceSha)) ||
    typeof receipt.version !== 'string' ||
    typeof receipt.buildNumber !== 'string' ||
    !/^[1-9]\d*$/.test(receipt.buildNumber) ||
    typeof receipt.buildTag !== 'string'
  )
    throw new Error('Native source receipt does not match the triggering run.');
  const tag = parseBuildTag(receipt.buildTag);
  if (
    tag?.platform !== workflowPlatform ||
    tag.version !== receipt.version ||
    String(tag.buildNumber) !== receipt.buildNumber
  )
    throw new Error('Native source receipt does not match its exact immutable build tag.');
  if (run.event === 'push' && receipt.sourceSha !== run.head_sha)
    throw new Error('A push build must use the pushed source commit.');
  if (runtime.tagCommit(receipt.buildTag) !== receipt.sourceSha || !runtime.isAncestor(String(receipt.sourceSha)))
    throw new Error('Native build tag must identify the source in main history.');
  return receipt as NativeBuildSource;
}

function main(): void {
  const [flag, runId] = process.argv.slice(2);
  if (flag !== '--run-id' || !runId || process.argv.length !== 4) throw new Error('Usage: --run-id <native run ID>');
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Missing repository identity.');
  const execute = (binary: string, argumentsList: string[]) =>
    execFileSync(binary, argumentsList, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    }).trim();
  execute('git', ['fetch', '--quiet', '--no-tags', 'origin', 'main:refs/remotes/origin/main']);
  const runtime: NativeSourceRuntime = {
    readRun: (id) => JSON.parse(execute('gh', ['api', `repos/${repository}/actions/runs/${id}`])),
    readArtifact: (id, attempt) => {
      const artifactName = `native-build-source-${attempt}`;
      const listing = JSON.parse(
        execute('gh', [
          'api',
          '--paginate',
          '--slurp',
          `repos/${repository}/actions/runs/${id}/artifacts?per_page=100`,
        ]),
      ) as Array<{ artifacts: Array<{ name: string; expired: boolean }> }>;
      const artifacts = listing
        .flatMap((page) => page.artifacts)
        .filter((artifact) => artifact.name === artifactName && !artifact.expired);
      if (!artifacts.length) return null;
      if (artifacts.length !== 1) throw new Error('Ambiguous native source artifacts.');
      const directory = mkdtempSync(join(tmpdir(), 'native-build-source-'));
      try {
        execute('gh', ['run', 'download', id, '--repo', repository, '--name', artifactName, '--dir', directory]);
        return JSON.parse(readFileSync(join(directory, 'native-build-source.json'), 'utf8')) as unknown;
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    tagCommit: (tag) => {
      execute('git', ['fetch', '--quiet', '--no-tags', 'origin', `refs/tags/${tag}`]);
      return execute('git', ['rev-parse', 'FETCH_HEAD^{commit}']);
    },
    isAncestor: (sha) => {
      try {
        execute('git', ['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main']);
        return true;
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'status' in error && error.status === 1) return false;
        throw error;
      }
    },
  };
  const receipt = resolveNativeBuildSource(runtime, runId, repository);
  const outputs = receipt
    ? {
        shipped: 'true',
        source_sha: receipt.sourceSha,
        version: receipt.version,
        build_number: receipt.buildNumber,
        build_tag: receipt.buildTag,
        platform: receipt.platform,
      }
    : { shipped: 'false' };
  const output = Object.entries(outputs)
    .map(([key, entry]) => `${key}=${entry}`)
    .join('\n');
  console.log(output);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
