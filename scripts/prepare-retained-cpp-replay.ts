/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { assertCppScreenshots } from './assert-cpp-screenshots';
import { readIosCampaignBoards } from './mobile-screenshots';
import { assertCppGradeCountProof, readCppCountFixtures } from './lib/cpp-grade-count';
import { resolveCppDetailReads } from './lib/cpp-detail-coverage';
import { extractArtifactZip } from './mobile-ota-stable-artifacts';
import { RETAINED_CPP_DEVICES, verifyRetainedCppSource } from './prepare-retained-cpp-record';
import { listFixtureFiles } from './lib/screenshot-backend';
import { canonicalJson, type GraphqlFixtureFile, type ScreenshotFixtureManifest } from './lib/screenshot-fixtures';
import {
  ensureScreenshotFixtures,
  fetchFixtureSnapshotReference,
  readFixtureSnapshotReference,
  type FixtureSnapshotReference,
} from './lib/screenshot-fixture-snapshot';
import {
  assertCppCaptureReady,
  CPP_MANIFEST_PATH,
  cppCaptureNames,
  isCppTarget,
  readCppPage,
  type CppTarget,
} from './lib/screenshot-cpp';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORKFLOW = '.github/workflows/mobile-screenshots-ios.yml';
const LOCALES = ['en-US', 'es', 'fr', 'de'] as const;
const STORE_LOCALES: Record<string, string[]> = {
  'en-US': ['en-US'],
  es: ['es-ES', 'es-MX'],
  fr: ['fr-FR'],
  de: ['de-DE'],
};
// Bind runtime code, including the native components that expose readiness anchors.
// Tooling-only changes stay reusable; any UI or shared renderer change needs fresh replay.
export function isReplayCapturePath(path: string): boolean {
  return (
    (path === '.github/actions/ios-screenshot-shard/action.yml' ||
      path === 'scripts/mobile-screenshots.ts' ||
      path === 'scripts/frame-screenshots.ts' ||
      [
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'vite.config.ts',
        'scripts/mobile-build-sim-app.ts',
        'scripts/mobile-ios-run.ts',
        'scripts/screenshot-sim.entitlements',
      ].includes(path) ||
      path.startsWith('patches/') ||
      /^scripts\/assert-(cpp-)?screenshot/.test(path) ||
      path.startsWith('scripts/lib/') ||
      path.startsWith('packages/mobile/.maestro/') ||
      path.startsWith('app-stores/presentation/') ||
      (path.startsWith('packages/shared/') && !/^packages\/shared\/(?:pr-body|email)\//.test(path)) ||
      path.startsWith('packages/board-constants/') ||
      /^packages\/mobile\/(?:app|src|plugins|modules|assets|locales)\//.test(path) ||
      /^packages\/mobile\/[^/]+\.(?:json|[cm]?[jt]s)$/.test(path)) &&
    !path.includes('/__tests__/') &&
    !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
  );
}
export const replayHash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const object = (candidate: unknown): candidate is Record<string, unknown> =>
  candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
const id = (candidate: unknown): candidate is number => Number.isSafeInteger(candidate) && Number(candidate) > 0;
const sha = (candidate: unknown): candidate is string =>
  typeof candidate === 'string' && /^[a-f\d]{40}$/.test(candidate);
const fail = (): never => {
  throw new Error('Retained CPP replay failed source, native replay, or reviewed receipt verification');
};
function json(bytes: Buffer | string): unknown {
  try {
    return JSON.parse(bytes.toString());
  } catch {
    return fail();
  }
}
function list(candidate: unknown): Record<string, unknown>[] {
  if (!Array.isArray(candidate) || candidate.some((entry) => !object(entry))) return fail();
  return candidate;
}

export interface ReplayClient {
  json(path: string): unknown;
  pages(path: string, field: string): Record<string, unknown>[];
  bytes(path: string): Buffer;
  source(commit: string, path: string): Buffer;
  files(commit: string): string[];
  isAncestor(producer: string, consumer: string): boolean;
}
export interface ReplayOptions {
  repository: string;
  runId: number;
  target: CppTarget;
  sourceSha: string;
  repoRoot: string;
  receipt: string;
  fixtureSnapshot?: string;
  expectedReceipt?: string;
  stage: boolean;
}
export interface ReplayArtifact {
  id: number;
  name: string;
  digest: string;
  locale: string;
  device: string;
  jobId: number;
}
export interface ReplayProducer {
  runId: number;
  attempt: 1;
  producerSha: string;
  jobIds: number[];
  artifacts: ReplayArtifact[];
  captureContractSha256: string;
}

/** A successful artifact upload alone is insufficient: uploads also run after failed captures. */
export function verifyReplayProducer(options: ReplayOptions, client: ReplayClient): ReplayProducer {
  if (
    options.repository !== 'boardsesh/boardsesh' ||
    !id(options.runId) ||
    !sha(options.sourceSha) ||
    !isCppTarget(options.target)
  )
    return fail();
  const prefix = `repos/${options.repository}/actions`;
  const run = client.json(`${prefix}/runs/${options.runId}`);
  const workflow = client.json(`${prefix}/workflows/mobile-screenshots-ios.yml`);
  if (
    !object(run) ||
    !object(workflow) ||
    !object(run.repository) ||
    !object(run.head_repository) ||
    run.id !== options.runId ||
    run.repository.full_name !== options.repository ||
    run.head_repository.full_name !== options.repository ||
    run.path !== WORKFLOW ||
    workflow.path !== WORKFLOW ||
    !id(workflow.id) ||
    run.workflow_id !== workflow.id ||
    run.event !== 'workflow_dispatch' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.run_attempt !== 1 ||
    !sha(run.head_sha) ||
    !client.isAncestor(run.head_sha, options.sourceSha)
  )
    return fail();
  const producerSha = run.head_sha;
  const sourceWorkflow: unknown = parse(client.source(producerSha, WORKFLOW).toString());
  const currentWorkflow: unknown = parse(readFileSync(join(options.repoRoot, WORKFLOW), 'utf8'));
  function contract(workflowDocument: unknown): unknown {
    if (!object(workflowDocument) || !object(workflowDocument.jobs)) return fail();
    const jobs = workflowDocument.jobs;
    if (
      !object(jobs.setup) ||
      !object(jobs.setup.env) ||
      !object(jobs.setup.outputs) ||
      jobs.setup.env.SOURCE_SHA !== '${{ github.event.workflow_run.head_sha || github.sha }}' ||
      jobs.setup.outputs.source_sha !== '${{ steps.compute.outputs.source_sha }}' ||
      !object(jobs['cpp-capture'])
    )
      return fail();
    const compute = list(jobs.setup.steps).find((step) => step.id === 'compute');
    if (!compute) return fail();
    return { compute, capture: jobs['cpp-capture'], build: jobs['ios-build'] };
  }
  const currentContract = contract(currentWorkflow);
  if (canonicalJson(contract(sourceWorkflow)) !== canonicalJson(currentContract)) return fail();
  const fileHashes: Record<string, string> = {};
  const paths = client.files(options.sourceSha).filter(isReplayCapturePath).sort();
  const priorPaths = client.files(producerSha).filter(isReplayCapturePath).sort();
  if (!paths.length || new Set(paths).size !== paths.length || canonicalJson(paths) !== canonicalJson(priorPaths))
    return fail();
  for (const path of paths) {
    const current = readFileSync(join(options.repoRoot, path));
    if (!client.source(producerSha, path).equals(current)) return fail();
    fileHashes[path] = replayHash(current);
  }
  const jobs = client.pages(`${prefix}/runs/${options.runId}/attempts/1/jobs?per_page=100`, 'jobs');
  if (
    jobs.some(
      (job) =>
        !id(job.id) ||
        job.run_attempt !== 1 ||
        job.status !== 'completed' ||
        !['success', 'skipped'].includes(String(job.conclusion)),
    ) ||
    new Set(jobs.map((job) => job.id)).size !== jobs.length
  )
    return fail();
  function requireJob(name: string, conclusion: string): Record<string, unknown> {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0].conclusion !== conclusion) return fail();
    return matches[0];
  }
  const required = [requireJob('setup', 'success'), requireJob('ios-build', 'success')];
  for (const name of ['cpp-bootstrap', 'cpp-prepare-record', 'cpp-finalize', 'cpp-create', 'cpp-plan', 'ios-finalize'])
    requireJob(name, 'skipped');
  if (jobs.filter((job) => String(job.name).startsWith('cpp-capture')).length !== 16) return fail();
  const available = client.pages(`${prefix}/runs/${options.runId}/artifacts?per_page=100`, 'artifacts');
  if (
    available.filter((artifact) => String(artifact.name).startsWith('ios-cpp-')).length !== 16 ||
    available.some((artifact) => String(artifact.name).startsWith('screenshot-fixtures-cpp-capture-'))
  )
    return fail();
  const artifacts: ReplayArtifact[] = [];
  for (const locale of LOCALES)
    for (const [deviceName, device] of RETAINED_CPP_DEVICES) {
      const job = requireJob(`cpp-capture (${options.target}, ${locale}, ${deviceName}, ${device})`, 'success');
      required.push(job);
      const name = `ios-cpp-${options.target}-cpp-capture-${locale}-${device}`;
      const matches = available.filter((artifact) => artifact.name === name);
      const artifact = matches[0];
      if (
        matches.length !== 1 ||
        !id(artifact.id) ||
        artifact.expired !== false ||
        typeof artifact.digest !== 'string' ||
        !/^sha256:[a-f\d]{64}$/.test(artifact.digest) ||
        !object(artifact.workflow_run) ||
        artifact.workflow_run.id !== options.runId ||
        artifact.workflow_run.head_sha !== producerSha ||
        !Number.isFinite(Date.parse(String(artifact.created_at))) ||
        !Number.isFinite(Date.parse(String(job.started_at))) ||
        !Number.isFinite(Date.parse(String(job.completed_at))) ||
        Date.parse(String(artifact.created_at)) < Date.parse(String(job.started_at)) ||
        Date.parse(String(artifact.created_at)) > Date.parse(String(job.completed_at))
      )
        return fail();
      artifacts.push({ id: artifact.id, name, digest: artifact.digest, locale, device, jobId: Number(job.id) });
    }
  if (new Set(artifacts.map((artifact) => artifact.id)).size !== 16) return fail();
  return {
    runId: options.runId,
    attempt: 1,
    producerSha,
    jobIds: required.map((job) => Number(job.id)),
    artifacts,
    captureContractSha256: replayHash(canonicalJson({ workflow: currentContract, files: fileHashes })),
  };
}

/** Each shard owns exactly one device and one app locale (Spanish owns both store locales). */
export function verifyReplayShard(
  directory: string,
  artifact: ReplayArtifact,
  target: CppTarget,
  fixture: FixtureSnapshotReference,
  manifest: ScreenshotFixtureManifest,
): void {
  const page = readCppPage(target);
  const rawNames = cppCaptureNames(page, artifact.device);
  const recipes = page.recipes[artifact.device.startsWith('ipad-') ? 'ipad' : 'phone'];
  const expected: string[] = [];
  for (const locale of STORE_LOCALES[artifact.locale] ?? []) {
    const raw = `raw-screenshots/${locale}/${artifact.device}`;
    const framed = `screenshots/${locale}/${artifact.device}`;
    expected.push(
      `${raw}/cpp-capture.json`,
      `${framed}/presentation.json`,
      ...rawNames.map((name) => `${raw}/${name}`),
      ...recipes.map((recipe) => `${framed}/${recipe.output}`),
    );
    if (existsSync(join(directory, framed, 'contact-sheet.jpg'))) expected.push(`${framed}/contact-sheet.jpg`);
    const capture = json(readFileSync(join(directory, raw, 'cpp-capture.json')));
    if (
      !object(capture) ||
      capture.target !== target ||
      capture.verified !== true ||
      capture.fixtureSha256 !== fixture.sha256 ||
      canonicalJson(capture.coverage) !== canonicalJson(manifest.capture?.cpp)
    )
      return fail();
  }
  if (!expected.length || canonicalJson(listFixtureFiles(directory)) !== canonicalJson(expected.sort())) return fail();
  // The Spanish output is a copy of one native replay. Both store variants must be byte-identical.
  if (artifact.locale === 'es')
    for (const path of expected.filter((path) => path.includes('/es-ES/'))) {
      if (
        !readFileSync(join(directory, path)).equals(readFileSync(join(directory, path.replace('/es-ES/', '/es-MX/'))))
      )
        return fail();
    }
}

/** Re-run current semantic gates; structural source coverage permits missing detail responses. */
export function verifyReplayFixture(directory: string, target: CppTarget): ScreenshotFixtureManifest {
  const manifest = verifyRetainedCppSource(directory, target);
  const fixtures = manifest.graphql.map(
    (entry) => json(readFileSync(join(directory, entry.file))) as GraphqlFixtureFile,
  );
  const reads = resolveCppDetailReads(manifest, fixtures);
  for (const expected of reads) {
    const matches = fixtures.filter(
      (fixture) =>
        fixture.operationName === expected.operationName &&
        fixture.variablesHash === expected.variablesHash &&
        fixture.documentHash === expected.documentHash,
    );
    if (matches.length !== 1) return fail();
  }
  assertCppGradeCountProof(manifest, readCppCountFixtures(directory, manifest));
  const page = readCppPage(target);
  const selectors = manifest.capture?.boards;
  if (!selectors || selectors.length !== 6 || new Set(selectors).size !== 6) return fail();
  const variants = [...page.heroBoards, ...page.otherBoards].map((board, index) => ({
    ...board,
    selector: selectors[index],
  }));
  const capturePage = {
    ...page,
    heroBoards: variants.slice(0, 3),
    otherBoards: variants.slice(3),
    primaryBoard: variants.find((board) => board.id === page.primaryBoard.id)!,
  };
  assertCppCaptureReady(target, capturePage, manifest.capture?.cpp, readIosCampaignBoards(directory), directory);
  return manifest;
}

export function requireReviewedReceipt(receipt: unknown, expected: string | undefined, stage: boolean): string {
  const digest = replayHash(`${canonicalJson(receipt)}\n`);
  if ((stage && !expected) || (expected !== undefined && (!/^[a-f\d]{64}$/.test(expected) || expected !== digest)))
    return fail();
  return digest;
}

export async function prepareRetainedReplay(options: ReplayOptions, client: ReplayClient): Promise<string> {
  const destination = join(options.repoRoot, 'app-stores/apple/cpp', options.target);
  if (
    existsSync(destination) ||
    existsSync(options.receipt) ||
    existsSync(`${options.receipt}.sha256`) ||
    (options.stage && !/^[a-f\d]{64}$/.test(options.expectedReceipt ?? ''))
  )
    return fail();
  const producer = verifyReplayProducer(options, client);
  const page = readCppPage(options.target);
  if (page.fixtureReference !== `app-stores/apple/cpp-fixtures/${options.target}.json`) return fail();
  const referencePath = join(options.repoRoot, page.fixtureReference);
  const reference = options.fixtureSnapshot
    ? await fetchFixtureSnapshotReference(options.fixtureSnapshot)
    : readFixtureSnapshotReference(referencePath);
  const fixturesDirectory = await ensureScreenshotFixtures(
    reference,
    join(options.repoRoot, '.boardsesh/screenshot-fixtures'),
  );
  const fixtureManifest = verifyReplayFixture(fixturesDirectory, options.target);
  mkdirSync(dirname(destination), { recursive: true });
  const scratch = mkdtempSync(join(dirname(destination), '.retained-replay-'));
  const previousReference = existsSync(referencePath) ? readFileSync(referencePath) : undefined;
  let referenceWritten = false;
  const assembled = join(scratch, 'assembled');
  mkdirSync(assembled);
  let installed = false;
  try {
    for (const artifact of producer.artifacts) {
      const archive = client.bytes(`repos/${options.repository}/actions/artifacts/${artifact.id}/zip`);
      if (archive.length > 128 * 1024 * 1024 || `sha256:${replayHash(archive)}` !== artifact.digest) return fail();
      const archivePath = join(scratch, `${artifact.id}.zip`);
      writeFileSync(archivePath, archive, { flag: 'wx' });
      const shard = join(scratch, String(artifact.id));
      extractArtifactZip(archivePath, shard);
      verifyReplayShard(shard, artifact, options.target, reference, fixtureManifest);
      for (const path of listFixtureFiles(shard)) {
        const output = join(assembled, path);
        if (existsSync(output)) return fail();
        mkdirSync(dirname(output), { recursive: true });
        cpSync(join(shard, path), output, { errorOnExist: true, force: false });
      }
    }
    // This local pin mirrors the existing candidate override; it never publishes a fixture or rewrites pixels.
    mkdirSync(dirname(referencePath), { recursive: true });
    referenceWritten = true;
    writeFileSync(referencePath, `${JSON.stringify(reference, null, 2)}\n`);
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(assembled, destination);
    installed = true;
    if (assertCppScreenshots(options.target, options.repoRoot) !== 180) return fail();
    const inventory = Object.fromEntries(
      listFixtureFiles(destination).map((path) => {
        const bytes = readFileSync(join(destination, path));
        return [
          path,
          {
            sha256: replayHash(bytes),
            bytes: bytes.length,
            ...(path.endsWith('.png') ? { md5: createHash('md5').update(bytes).digest('hex') } : {}),
          },
        ];
      }),
    );
    const receipt = {
      version: 1,
      repository: options.repository,
      target: options.target,
      ...producer,
      manifestSha256: replayHash(readFileSync(CPP_MANIFEST_PATH)),
      fixture: reference,
      fixtureManifestSha256: replayHash(readFileSync(join(fixturesDirectory, 'manifest.json'))),
      screenshots: 180,
      inventory,
    };
    const digest = requireReviewedReceipt(receipt, options.expectedReceipt, options.stage);
    // Catch reruns, artifact replacement/expiry, or changed job metadata during downloads.
    if (canonicalJson(verifyReplayProducer(options, client)) !== canonicalJson(producer)) return fail();
    writeFileSync(options.receipt, `${canonicalJson(receipt)}\n`, { flag: 'wx' });
    writeFileSync(`${options.receipt}.sha256`, `${digest}\n`, { flag: 'wx' });
    return digest;
  } catch {
    if (installed) rmSync(destination, { recursive: true, force: true });
    if (referenceWritten) {
      if (previousReference) writeFileSync(referencePath, previousReference);
      else rmSync(referencePath, { force: true });
    }
    return fail();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function createReplayClient(): ReplayClient {
  const api = (args: string[]): Buffer =>
    execFileSync('gh', ['api', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
      maxBuffer: 128 * 1024 * 1024,
    });
  return {
    json: (path) => json(api([path])),
    pages: (path, field) => list(json(api(['--paginate', '--slurp', path]))).flatMap((page) => list(page[field])),
    // Arbitrary ZIP bytes remain in internal pipes; raw errors never reach the terminal.
    bytes: (path) => api(['--allow-escape-sequences', path]),
    files: (commit) =>
      execFileSync('git', ['ls-tree', '-rz', '--name-only', commit], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
      })
        .split('\0')
        .filter(Boolean),
    source: (commit, path) =>
      execFileSync('git', ['show', `${commit}:${path}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      }),
    isAncestor: (producer, consumer) => {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', producer, consumer], { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    },
  };
}
export async function main(argv: string[]): Promise<void> {
  if (
    argv.length !== 2 ||
    argv[0] !== '--receipt' ||
    !isCppTarget(process.env.CPP_TARGET) ||
    !/^[1-9]\d*$/.test(process.env.CPP_REPLAY_RUN_ID ?? '') ||
    !['verify', 'stage-assets'].includes(process.env.CPP_REPLAY_MODE ?? '') ||
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim() !== process.env.GITHUB_SHA
  )
    return fail();
  const digest = await prepareRetainedReplay(
    {
      repository: process.env.GITHUB_REPOSITORY ?? '',
      runId: Number(process.env.CPP_REPLAY_RUN_ID),
      target: process.env.CPP_TARGET,
      sourceSha: process.env.GITHUB_SHA ?? '',
      repoRoot: ROOT,
      receipt: resolve(argv[1]),
      fixtureSnapshot: process.env.FIXTURE_SNAPSHOT_URL || undefined,
      expectedReceipt: process.env.EXPECTED_RECEIPT_SHA256 || undefined,
      stage: process.env.CPP_REPLAY_MODE === 'stage-assets',
    },
    createReplayClient(),
  );
  console.log(`Verified 180 retained CPP screenshots. Reviewed receipt SHA256: ${digest}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(() => {
    console.error('Retained CPP replay failed source, native replay, or reviewed receipt verification');
    process.exitCode = 1;
  });
