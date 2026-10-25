/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatBuildTag, shortFingerprint } from './lib/release-tags';
import {
  objectFields,
  parseTestflightBuildReceipt,
  previousNativeBuild,
  TESTFLIGHT_RECEIPT_ARTIFACT,
  trustedTestflightRun,
  validateReceiptSource,
} from './lib/testflight-build';

function command(binary: string, argumentsList: string[]): string {
  return execFileSync(binary, argumentsList, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

function requiredEnvironment(name: string): string {
  const contents = process.env[name];
  if (!contents) throw new Error(`Missing ${name}.`);
  return contents;
}

function github(path: string): unknown {
  return JSON.parse(command('gh', ['api', path]));
}

function emit(outputs: Record<string, string>): void {
  if (Object.values(outputs).some((contents) => /[\r\n]/.test(contents)))
    throw new Error('GitHub outputs must be single-line strings.');
  const outputPath = requiredEnvironment('GITHUB_OUTPUT');
  appendFileSync(
    outputPath,
    Object.entries(outputs)
      .map(([name, contents]) => `${name}=${contents}\n`)
      .join(''),
  );
}

function writeJson(outputPath: string, contents: unknown): void {
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(contents, null, 2)}\n`);
}

export function main(argumentsList = process.argv.slice(2)): void {
  const [action, ...flags] = argumentsList;
  const options = new Map<string, string>();
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const contents = flags[index + 1];
    if (!['--output', '--run-id', '--receipt'].includes(flag) || !contents)
      throw new Error(`Invalid argument ${flag}.`);
    options.set(flag, contents);
  }
  const option = (name: string): string => {
    const contents = options.get(name);
    if (!contents) throw new Error(`Missing ${name}.`);
    return contents;
  };
  if (action === 'capture') {
    const version = requiredEnvironment('BOARDSESH_MOBILE_VERSION');
    const buildNumber = requiredEnvironment('IOS_BUILD_NUMBER');
    const sourceSha = requiredEnvironment('GITHUB_SHA');
    const sourceRef = requiredEnvironment('GITHUB_REF_NAME');
    const tags = command('git', [
      'for-each-ref',
      `--merged=${sourceSha}`,
      '--format=%(refname:short) %(objectname) %(*objectname)',
      'refs/tags/build-ios-*',
    ])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, directSha, peeledSha] = line.split(/\s+/);
        return { name, sha: peeledSha || directSha };
      });
    const ancestorShas = command('git', ['rev-list', '--topo-order', sourceSha]).split('\n');
    const previous = previousNativeBuild(tags, ancestorShas, version, buildNumber);
    writeJson(
      option('--output'),
      parseTestflightBuildReceipt({
        version,
        buildNumber,
        sourceSha,
        sourceRef,
        sourceRunId: requiredEnvironment('GITHUB_RUN_ID'),
        buildTag: formatBuildTag(
          'ios',
          version,
          Number(buildNumber),
          shortFingerprint(requiredEnvironment('FINGERPRINT_IOS')),
        ),
        previousBuildTag: previous?.name ?? null,
        previousBuildSha: previous?.sha ?? null,
      }),
    );
    return;
  }
  if (action !== 'resolve' && action !== 'validate') throw new Error('Expected capture, resolve, or validate.');
  const runId = option('--run-id');
  if (!/^[1-9]\d*$/.test(runId)) throw new Error('Invalid source run ID.');
  const repository = requiredEnvironment('GITHUB_REPOSITORY');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository.');
  const sourceAttempt = process.env.SOURCE_RUN_ATTEMPT;
  if (sourceAttempt && !/^[1-9]\d*$/.test(sourceAttempt)) throw new Error('Invalid source run attempt.');
  const attemptPath = sourceAttempt ? `/attempts/${sourceAttempt}` : '';
  const run = trustedTestflightRun(github(`/repos/${repository}/actions/runs/${runId}${attemptPath}`), repository);
  if (run.id !== runId) throw new Error('GitHub returned a different source run.');
  if (sourceAttempt && String(run.attempt) !== sourceAttempt)
    throw new Error('GitHub returned a different run attempt.');
  if (action === 'resolve') {
    const artifactName = `${TESTFLIGHT_RECEIPT_ARTIFACT}-${run.attempt}`;
    const pages: unknown = JSON.parse(
      command('gh', [
        'api',
        '--paginate',
        '--slurp',
        `/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
      ]),
    );
    if (!Array.isArray(pages)) throw new Error('Unreadable native build artifacts.');
    const artifacts = pages
      .flatMap((page: unknown) => {
        const { artifacts: entries } = objectFields(page);
        if (!Array.isArray(entries)) throw new Error('Unreadable native build artifacts.');
        return entries.map((entry: unknown) => objectFields(entry));
      })
      .filter((artifact) => artifact.name === artifactName && artifact.expired === false);
    if (artifacts.length === 0) {
      const jobs = objectFields(
        github(`/repos/${repository}/actions/runs/${runId}/attempts/${run.attempt}/jobs?per_page=100`),
      );
      if (
        Array.isArray(jobs.jobs) &&
        jobs.jobs.some((job: unknown) => {
          const fields = objectFields(job);
          return fields.name === 'build-and-upload' && fields.conclusion === 'skipped';
        })
      ) {
        emit({ should_distribute: 'false' });
        console.log('Native gate skipped this run; no build to distribute.');
        return;
      }
      throw new Error(
        `Missing ${artifactName} receipt. Choose a native build made after receipt capture was installed.`,
      );
    }
    if (artifacts.length !== 1 || typeof artifacts[0].id !== 'number' || !Number.isSafeInteger(artifacts[0].id)) {
      throw new Error('Ambiguous native build receipt artifact.');
    }
    emit({
      should_distribute: 'true',
      artifact_id: String(artifacts[0].id),
      source_run_id: run.id,
      source_run_attempt: String(run.attempt),
    });
    return;
  }
  const receipt = parseTestflightBuildReceipt(JSON.parse(readFileSync(option('--receipt'), 'utf8')));
  validateReceiptSource(receipt, run);
  const resolveTag = (tag: string) => command('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
  if (resolveTag(receipt.buildTag) !== receipt.sourceSha) throw new Error('Uploaded build tag moved or is missing.');
  if (receipt.previousBuildTag && receipt.previousBuildSha) {
    if (resolveTag(receipt.previousBuildTag) !== receipt.previousBuildSha) throw new Error('Previous build tag moved.');
    command('git', ['merge-base', '--is-ancestor', receipt.previousBuildSha, receipt.sourceSha]);
  }
  emit({ version: receipt.version, build_number: receipt.buildNumber });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`[testflight-build] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
