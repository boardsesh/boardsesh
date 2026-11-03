/// <reference types="node" />

/** Read-only retry selection and attempt receipts; Apple writes stay in Fastlane. */
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  objectFields,
  parseTestflightBuildReceipt,
  TESTFLIGHT_RECEIPT_ARTIFACT,
  trustedTestflightRun,
} from './lib/testflight-build';
import { createTestflightCommandRunner } from './lib/testflight-github';
import {
  createDistributionResult,
  DISTRIBUTION_WORKFLOW,
  latestUploadedIosBuild,
  parseDistributionResult,
  readSupersededTestflightSources,
  retryableDistribution,
  type DistributionResult,
} from './lib/testflight-distribution';
import { getSupersededNativeStampShas } from './mobile-native-release';

function required(name: string): string {
  const contents = process.env[name];
  if (!contents) throw new Error(`Missing ${name}.`);
  return contents;
}
function emit(outputs: Record<string, string>): void {
  if (Object.values(outputs).some((contents) => /[\r\n]/.test(contents))) throw new Error('Invalid GitHub output.');
  appendFileSync(
    required('GITHUB_OUTPUT'),
    Object.entries(outputs)
      .map(([name, contents]) => `${name}=${contents}\n`)
      .join(''),
  );
}
function artifactFiles(directory: string, basename: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return artifactFiles(path, basename);
    return entry.isFile() && entry.name === basename ? [path] : [];
  });
}

const NATIVE_RUN_SCAN = 100;

/** The finished upload run whose own receipt names this exact build tag and source. */
function findUploadRun(
  repository: string,
  latestBuild: { name: string; sha: string },
  json: (path: string) => unknown,
  command: (binary: string, argumentsList: string[]) => string,
): { id: string; attempt: number } | null {
  const response = objectFields(
    json(
      `/repos/${repository}/actions/workflows/ios-testflight-rn.yml/runs?status=success&per_page=${NATIVE_RUN_SCAN}`,
    ),
  );
  if (!Array.isArray(response.workflow_runs)) throw new Error('Unreadable native build runs.');
  for (const entry of response.workflow_runs) {
    // run-name is `ios:<native source sha>`; the receipt below is the proof.
    if (objectFields(entry).display_title !== `ios:${latestBuild.sha}`) continue;
    let run: ReturnType<typeof trustedTestflightRun>;
    try {
      run = trustedTestflightRun(entry, repository);
    } catch {
      // One odd same-titled run must not stop every hourly retry; the receipt is the proof.
      continue;
    }
    const artifactName = `${TESTFLIGHT_RECEIPT_ARTIFACT}-${run.attempt}`;
    const listing = objectFields(
      json(`/repos/${repository}/actions/runs/${run.id}/artifacts?name=${artifactName}&per_page=100`),
    );
    if (!Array.isArray(listing.artifacts)) throw new Error('Unreadable native build artifacts.');
    const receipts = listing.artifacts
      .map(objectFields)
      .filter((artifact) => artifact.name === artifactName && artifact.expired === false);
    if (receipts.length === 0) continue;
    if (receipts.length !== 1) throw new Error('Ambiguous native build receipt artifact.');
    const directory = mkdtempSync(join(tmpdir(), 'testflight-upload-'));
    try {
      command('gh', ['run', 'download', run.id, '--repo', repository, '--name', artifactName, '--dir', directory]);
      const files = artifactFiles(directory, 'testflight-build.json');
      if (files.length !== 1) throw new Error('Missing or ambiguous native build receipt.');
      const receipt = parseTestflightBuildReceipt(JSON.parse(readFileSync(files[0], 'utf8')));
      if (
        receipt.buildTag === latestBuild.name &&
        receipt.sourceSha === latestBuild.sha &&
        receipt.sourceRunId === run.id
      )
        return { id: run.id, attempt: run.attempt };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  return null;
}

export function main(
  argumentsList = process.argv.slice(2),
  execute: (binary: string, argumentsList: string[]) => string = createTestflightCommandRunner(),
  readLineage = getSupersededNativeStampShas,
): void {
  const command = (binary: string, argumentsList: string[]) => execute(binary, argumentsList).trim();
  const json = (path: string): unknown => JSON.parse(command('gh', ['api', path]));
  const action = argumentsList[0];
  if (action === 'record') {
    if (argumentsList.length !== 1) throw new Error('record accepts no arguments.');
    const receipt = parseTestflightBuildReceipt(JSON.parse(readFileSync(required('TESTFLIGHT_BUILD_RECEIPT'), 'utf8')));
    const lanePath = process.env.TESTFLIGHT_DISTRIBUTION_OUTPUT;
    const laneReceipt: unknown =
      lanePath && existsSync(lanePath) ? JSON.parse(readFileSync(lanePath, 'utf8')) : undefined;
    const result = createDistributionResult(
      receipt,
      {
        sourceRunAttempt: Number(required('SOURCE_RUN_ATTEMPT')),
        distributionRunId: required('GITHUB_RUN_ID'),
        distributionRunAttempt: Number(required('GITHUB_RUN_ATTEMPT')),
        checkedAt: new Date().toISOString(),
      },
      laneReceipt,
    );
    const outputPath = required('TESTFLIGHT_RESULT_OUTPUT');
    mkdirSync(dirname(resolve(outputPath)), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `- TestFlight ${result.version} (${result.buildNumber}): **${result.status}**. Source run ${result.sourceRunId}, attempt ${result.sourceRunAttempt}.\n`,
      );
    return;
  }
  if (action !== 'select' || argumentsList.length !== 1) throw new Error('Expected select or record.');
  const repository = required('GITHUB_REPOSITORY');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository.');
  const supersededSources = readSupersededTestflightSources(execute, readLineage);
  const latestBuild = latestUploadedIosBuild(
    command('git', ['for-each-ref', '--format=%(refname:short) %(objectname) %(*objectname)', 'refs/tags/build-ios-*'])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, directSha, peeledSha] = line.split(/\s+/);
        return { name, sha: peeledSha || directSha };
      }),
    supersededSources,
  );
  if (!latestBuild) {
    emit({ selected: 'false' });
    return;
  }
  // GitHub orders runs by creation, not their latest rerun's completion. Scan all
  // bounded pages and compare result times before authorizing any retry.
  const outcomes: Array<{ result: DistributionResult | null; checkedAt: number }> = [];
  const seen = new Set<string>();
  let complete = false;
  for (let page = 1; page <= 200; page += 1) {
    const response = objectFields(
      json(
        `/repos/${repository}/actions/workflows/ios-testflight-distribute.yml/runs?status=completed&per_page=100&page=${page}`,
      ),
    );
    if (!Array.isArray(response.workflow_runs)) throw new Error('Unreadable distribution workflow runs.');
    for (const entry of response.workflow_runs) {
      const run = objectFields(entry);
      if (
        run.path !== DISTRIBUTION_WORKFLOW ||
        run.head_branch !== 'main' ||
        objectFields(run.head_repository).full_name !== repository ||
        typeof run.id !== 'number' ||
        !Number.isSafeInteger(run.id) ||
        run.id <= 0 ||
        typeof run.run_attempt !== 'number' ||
        !Number.isSafeInteger(run.run_attempt) ||
        run.run_attempt <= 0
      )
        throw new Error('Untrusted distribution workflow run.');
      const attemptKey = `${run.id}:${run.run_attempt}`;
      if (seen.has(attemptKey)) continue;
      seen.add(attemptKey);
      const artifactName = `testflight-distribution-${run.run_attempt}`;
      const response = objectFields(
        json(`/repos/${repository}/actions/runs/${run.id}/artifacts?name=${artifactName}&per_page=100`),
      );
      if (!Array.isArray(response.artifacts)) throw new Error('Unreadable distribution artifacts.');
      const artifacts = response.artifacts
        .map(objectFields)
        .filter((artifact) => artifact.name === artifactName && artifact.expired === false);
      if (artifacts.length === 0) continue;
      if (artifacts.length !== 1) throw new Error('Ambiguous distribution result artifact.');
      const directory = mkdtempSync(join(tmpdir(), 'testflight-result-'));
      try {
        command('gh', [
          'run',
          'download',
          String(run.id),
          '--repo',
          repository,
          '--name',
          artifactName,
          '--dir',
          directory,
        ]);
        const files = artifactFiles(directory, 'distribution-result.json');
        let result: DistributionResult | null = null;
        try {
          if (files.length !== 1) throw new Error('Missing or ambiguous distribution result.');
          result = parseDistributionResult(JSON.parse(readFileSync(files[0], 'utf8')));
          if (result.distributionRunId !== String(run.id) || result.distributionRunAttempt !== run.run_attempt)
            throw new Error('Distribution result does not belong to its workflow attempt.');
        } catch {
          // Older artifacts still archive the exact native receipt. Use it to
          // ignore unrelated history, never to invent permission to retry.
          const receipts = artifactFiles(directory, 'testflight-build.json');
          if (receipts.length === 1) {
            const receipt = parseTestflightBuildReceipt(JSON.parse(readFileSync(receipts[0], 'utf8')));
            if (receipt.buildTag !== latestBuild.name || receipt.sourceSha !== latestBuild.sha) continue;
          }
          const updatedAt = typeof run.updated_at === 'string' ? Date.parse(run.updated_at) : NaN;
          if (!Number.isFinite(updatedAt))
            throw new Error('Unreadable completion time for an unclassified distribution attempt.');
          outcomes.push({ result: null, checkedAt: updatedAt });
          continue;
        }
        if (result.buildTag === latestBuild.name && result.sourceSha === latestBuild.sha) {
          outcomes.push({ result, checkedAt: Date.parse(result.checkedAt) });
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
    if (response.workflow_runs.length < 100) {
      complete = true;
      break;
    }
  }
  if (!complete) throw new Error('Incomplete TestFlight distribution history; explicit recovery is required.');
  const newest = outcomes.sort(
    (left, right) => right.checkedAt - left.checkedAt || Number(left.result !== null) - Number(right.result !== null),
  )[0];
  if (newest && !newest.result)
    throw new Error(
      'Newest matching distribution attempt has no valid result; explicit source_run_id recovery is required.',
    );
  if (outcomes.length === 0) {
    // No distribution ever saw this upload. Main Native Release dispatches
    // recovery builds with GITHUB_TOKEN, and GitHub sends no workflow_run for
    // those, so 2.7.0 builds 11 and 12 waited here with nothing to retry.
    const upload = findUploadRun(repository, latestBuild, json, command);
    emit(
      upload
        ? { selected: 'true', source_run_id: upload.id, source_run_attempt: String(upload.attempt) }
        : { selected: 'false' },
    );
    console.log(
      upload
        ? `Newest uploaded iOS build: ${latestBuild.name}; never distributed, delivering from run ${upload.id}.`
        : `::warning::Newest uploaded iOS build ${latestBuild.name} was never distributed and its finished upload run is not among the newest ${NATIVE_RUN_SCAN}. Dispatch this workflow with its source_run_id.`,
    );
    return;
  }
  const retry = retryableDistribution(
    latestBuild,
    outcomes.flatMap((outcome) => (outcome.result ? [outcome.result] : [])),
  );
  emit(
    retry
      ? { selected: 'true', source_run_id: retry.sourceRunId, source_run_attempt: String(retry.sourceRunAttempt) }
      : { selected: 'false' },
  );
  console.log(
    `Newest uploaded iOS build: ${latestBuild.name}; distribution ${newest?.result?.status ?? 'unclassified'}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`[testflight-distribution] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
