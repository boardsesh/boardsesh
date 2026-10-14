/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { parse } from 'yaml';
import {
  readCppCaptureSource,
  verifyCppCaptureCompatibility,
  type CppCaptureSourceContext,
} from './assert-cpp-screenshots';
import {
  retainedArtifactExecution,
  retainedExecution,
  retainedHistory,
  type RetainedExecution,
  type RetainedRetryHistory,
} from './lib/cpp-retained-history';
import { extractArtifactZip } from './mobile-ota-stable-artifacts';
import { findOffenders } from './assert-screenshot-dimensions';
import { DEFAULT_MIN_BYTES } from './assert-screenshot-content';
import { resolveCppDetailReads } from './lib/cpp-detail-coverage';
import { readScreenshotFixtureManifest, listFixtureFiles } from './lib/screenshot-backend';
import { canonicalJson, type GraphqlFixtureFile, type ScreenshotFixtureManifest } from './lib/screenshot-fixtures';
import { CPP_MANIFEST_PATH, isCppTarget, readCppPage, resolveCppRecipes, type CppTarget } from './lib/screenshot-cpp';

const MAX_RECORD_ATTEMPTS = 10;
const SKIPPED_RECORD_JOBS = ['cpp-finalize', 'cpp-create', 'cpp-plan', 'ios-finalize', 'ios-capture', 'probe'];
const WORKFLOW_PATH = '.github/workflows/mobile-screenshots-ios.yml';
export const RETAINED_CPP_DEVICES = [
  ['iPhone 16 Pro Max', 'iphone-16-pro-max'],
  ['iPhone 16 Pro', 'iphone-16-pro'],
  ['iPad Pro 13-inch (M5)', 'ipad-pro-13-inch-m5'],
  ['iPad Pro 11-inch (M5)', 'ipad-pro-11-inch-m5'],
] as const;
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const object = (candidateObject: unknown): candidateObject is Record<string, unknown> =>
  candidateObject !== null && typeof candidateObject === 'object' && !Array.isArray(candidateObject);
const id = (candidateId: unknown): candidateId is number =>
  Number.isSafeInteger(candidateId) && Number(candidateId) > 0;
const sha = (candidateSha: unknown): candidateSha is string =>
  typeof candidateSha === 'string' && /^[a-f\d]{40}$/.test(candidateSha);
const fail = (): never => {
  throw new Error('Retained CPP recording failed source or artifact verification');
};
function json(bytes: string | Buffer): unknown {
  try {
    return JSON.parse(bytes.toString());
  } catch {
    return fail();
  }
}
function list(candidateList: unknown): Record<string, unknown>[] {
  if (!Array.isArray(candidateList) || candidateList.some((entry) => !object(entry))) return fail();
  return candidateList as Record<string, unknown>[];
}

export interface RetainedCppClient {
  json(path: string): unknown;
  pages(path: string, field: string): Record<string, unknown>[];
  bytes(path: string): Buffer;
  isAncestor(producerSha: string, preparerSha: string): boolean;
  workflow(producerSha: string): string;
  source(producerSha: string, path: string): Buffer;
  isCommit(commit: string): boolean;
}
export interface RetainedCppOptions {
  repository: string;
  runId: number;
  target: CppTarget;
  preparerSha: string;
  out: string;
  receipt: string;
}
interface SelectedArtifact {
  id: number;
  name: string;
  digest: string;
  kind: 'recording' | 'native' | 'bootstrap';
  device?: string;
  jobId?: number;
  attempt?: number;
}
interface Producer {
  runId: number;
  attempt: number;
  producerSha: string;
  preparerSha: string;
  jobIds: number[];
  artifacts: SelectedArtifact[];
  retryHistory?: RetainedRetryHistory;
  captureSource?: CppCaptureSourceContext;
  compatibility?: ReturnType<typeof verifyCppCaptureCompatibility>;
}

// Full readback inputs are private: legacy public receipt bytes remain unchanged.
const verifiedInputs = new WeakMap<Producer, { sha256: string; artifactSizes: Map<number, number> }>();

/** Read actual original job output, never shell source that merely mentions the expected inputs. */
function verifyRecordInputs(log: Buffer, target: CppTarget, producerSha: string): void {
  if (log.length > 2 * 1024 * 1024) return fail();
  const lines = stripVTControlCharacters(log.toString()).split(/\r?\n/);
  for (const [name, expected] of Object.entries({
    SOURCE_SHA: producerSha,
    CPP_TARGET: target,
    CPP_ACTION: 'capture',
    FIXTURES_MODE: 'record',
    LOCALES: 'en-US',
    UPLOAD_DEFAULT: 'false',
    PUBLISH_BASELINE: 'false',
  })) {
    const values = lines.flatMap((line) => {
      const match = line.match(new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+Z   ${name}: (.*)$`));
      return match ? [match[1]] : [];
    });
    if (!values.length || values.some((entry) => entry !== expected)) return fail();
  }
  const resolved = lines.filter((line) => /^\d{4}-\d{2}-\d{2}T\S+Z Resolved: /.test(line));
  if (
    resolved.length !== 1 ||
    !resolved[0].endsWith(
      `Resolved: gate=full ios_locales=["en-US"] upload=false flow=app-store source_sha=${producerSha}`,
    )
  )
    return fail();
}

/** Reconcile carried successes with their original executions; all four devices remain mandatory. */
export function verifyRetainedCppProducer(options: RetainedCppOptions, client: RetainedCppClient): Producer {
  if (
    options.repository !== 'boardsesh/boardsesh' ||
    !id(options.runId) ||
    !isCppTarget(options.target) ||
    !sha(options.preparerSha)
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
    run.path !== WORKFLOW_PATH ||
    !id(workflow.id) ||
    run.workflow_id !== workflow.id ||
    workflow.path !== WORKFLOW_PATH ||
    run.event !== 'workflow_dispatch' ||
    run.status !== 'completed' ||
    !['success', 'failure'].includes(String(run.conclusion)) ||
    !id(run.run_attempt) ||
    run.run_attempt > MAX_RECORD_ATTEMPTS ||
    !sha(run.head_sha) ||
    !client.isCommit(run.head_sha) ||
    !client.isCommit(options.preparerSha) ||
    !client.isAncestor(run.head_sha, options.preparerSha)
  )
    return fail();
  const producerSha = run.head_sha;
  const attempt = run.run_attempt;
  const captureSource = readCppCaptureSource(options.target, producerSha, (path) => client.source(producerSha, path));
  const compatibility = verifyCppCaptureCompatibility(options.target, captureSource);
  const source: unknown = parse(client.workflow(producerSha));
  if (
    !object(source) ||
    !object(source.jobs) ||
    !object(source.jobs.setup) ||
    !object(source.jobs.setup.env) ||
    source.jobs.setup.env.SOURCE_SHA !== '${{ github.event.workflow_run.head_sha || github.sha }}' ||
    !object(source.jobs['cpp-capture'])
  )
    return fail();
  const currentWorkflow: unknown = parse(readFileSync(WORKFLOW_PATH, 'utf8'));
  if (
    !object(source.jobs.setup.outputs) ||
    source.jobs.setup.outputs.source_sha !== '${{ steps.compute.outputs.source_sha }}' ||
    !object(currentWorkflow) ||
    !object(currentWorkflow.jobs) ||
    !object(currentWorkflow.jobs.setup)
  )
    return fail();
  const sourceCompute = list(source.jobs.setup.steps).find((step) => step.id === 'compute');
  const currentCompute = list(currentWorkflow.jobs.setup.steps).find((step) => step.id === 'compute');
  if (!sourceCompute || !currentCompute || canonicalJson(sourceCompute) !== canonicalJson(currentCompute))
    return fail();
  const captureSteps = list(source.jobs['cpp-capture'].steps);
  const checkout = captureSteps.find((step) => step.uses === 'actions/checkout@v4');
  const capture = captureSteps.find((step) => step.uses === './.github/actions/ios-screenshot-shard');
  if (
    !checkout ||
    !object(checkout.with) ||
    checkout.with.ref !== '${{ needs.setup.outputs.source_sha }}' ||
    !capture ||
    !object(capture.with) ||
    capture.with.fixtures !== "${{ inputs.fixtures || 'replay' }}" ||
    capture.with.flow !== 'app-store'
  )
    return fail();
  const jobs = client.pages(`${prefix}/runs/${options.runId}/attempts/${attempt}/jobs?per_page=100`, 'jobs');
  if (
    jobs.some(
      (job) =>
        !id(job.id) ||
        job.run_attempt !== attempt ||
        job.run_id !== options.runId ||
        job.head_sha !== producerSha ||
        job.status !== 'completed',
    ) ||
    new Set(jobs.map((job) => job.id)).size !== jobs.length
  )
    return fail();
  const requiredNames = [
    'setup',
    'cpp-bootstrap',
    ...RETAINED_CPP_DEVICES.map(([name, slug]) => `cpp-capture (${options.target}, en-US, ${name}, ${slug})`),
  ];
  const required = requiredNames.map((name) => {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0].conclusion !== 'success') return fail();
    return matches[0];
  });
  if (jobs.filter((job) => String(job.name).startsWith('cpp-capture')).length !== 4) return fail();
  const allowedNames = [...requiredNames, 'ios-build', 'cpp-prepare-record', ...SKIPPED_RECORD_JOBS];
  if (jobs.some((job) => !allowedNames.includes(String(job.name)))) return fail();
  const build = jobs.filter((job) => job.name === 'ios-build');
  if (build.length !== 1 || build[0].conclusion !== 'success') return fail();
  for (const job of jobs)
    if (SKIPPED_RECORD_JOBS.includes(String(job.name)) && job.conclusion !== 'skipped') return fail();
  const retry =
    attempt > 1
      ? retainedHistory(prefix, options.runId, attempt, producerSha, jobs, client, SKIPPED_RECORD_JOBS, fail)
      : undefined;
  function originalJob(job: Record<string, unknown>): RetainedExecution | undefined {
    if (!retry) return undefined;
    const signature = retainedExecution(job, fail).signatureSha256;
    const original = retry.executions.find((entry) => entry.signatureSha256 === signature);
    if (!original || original.conclusion !== 'success') return fail();
    retry.history.selectedExecutions.push({ ...original, latestJobId: Number(job.id) });
    return original;
  }
  for (const job of [...required, build[0]]) retainedExecution(job, fail);
  if (retry)
    for (const prior of retry.executions) {
      if (prior.conclusion !== 'failure' || prior.name.startsWith('cpp-capture')) continue;
      if (
        prior.name !== 'cpp-prepare-record' ||
        !client
          .bytes(`${prefix}/jobs/${prior.jobId}/logs`)
          .toString()
          .includes('CPP detail source lacks the genuine owned leader primary queue')
      )
        return fail();
    }
  const originals = new Map(required.map((job) => [job.name, originalJob(job)]));
  originalJob(build[0]);
  verifyRecordInputs(
    client.bytes(`${prefix}/jobs/${originals.get('setup')?.jobId ?? Number(required[0].id)}/logs`),
    options.target,
    producerSha,
  );
  const failures = jobs.filter((job) => !['success', 'skipped'].includes(String(job.conclusion)));
  if (run.conclusion === 'failure') {
    if (
      failures.length !== 1 ||
      failures[0].name !== 'cpp-prepare-record' ||
      failures[0].conclusion !== 'failure' ||
      !client
        .bytes(`${prefix}/jobs/${Number(failures[0].id)}/logs`)
        .toString()
        .includes('CPP detail source lacks the genuine owned leader primary queue')
    )
      return fail();
  } else if (failures.length) return fail();
  const artifacts = client.pages(`${prefix}/runs/${options.runId}/artifacts?per_page=100`, 'artifacts');
  const selected: SelectedArtifact[] = [];
  function select(name: string, kind: SelectedArtifact['kind'], job: Record<string, unknown>, device?: string) {
    const original = originals.get(job.name);
    const candidates = artifacts.filter((artifact) => artifact.name === name);
    if (candidates.some((artifact) => !id(artifact.size_in_bytes) || artifact.size_in_bytes > 128 * 1024 * 1024))
      return fail();
    const matches = retry
      ? candidates.filter((artifact) => {
          const bound = retainedArtifactExecution(
            artifact,
            String(job.name),
            retry.executions,
            options.runId,
            producerSha,
            fail,
          );
          const matched = bound.execution;
          if (matched.signatureSha256 === original?.signatureSha256) return true;
          if (matched.conclusion !== 'failure') return fail();
          retry.history.excludedArtifacts.push({
            id: bound.id,
            name,
            digest: bound.digest,
            createdAt: bound.createdAt,
            jobId: matched.jobId,
            attempt: matched.attempt,
          });
          return false;
        })
      : candidates;
    const artifact = matches[0];
    if (
      matches.length !== 1 ||
      !id(artifact.id) ||
      artifact.expired !== false ||
      typeof artifact.digest !== 'string' ||
      !/^sha256:[a-f\d]{64}$/.test(artifact.digest) ||
      !Number.isFinite(Date.parse(String(artifact.created_at))) ||
      !Number.isFinite(Date.parse(String(job.started_at))) ||
      !Number.isFinite(Date.parse(String(job.completed_at))) ||
      Date.parse(String(artifact.created_at)) < Date.parse(String(job.started_at)) ||
      Date.parse(String(artifact.created_at)) > Date.parse(String(job.completed_at)) ||
      !object(artifact.workflow_run) ||
      artifact.workflow_run.id !== options.runId ||
      artifact.workflow_run.head_sha !== producerSha
    )
      return fail();
    selected.push({
      id: artifact.id,
      name,
      digest: artifact.digest,
      kind,
      ...(device ? { device } : {}),
      ...(original ? { jobId: original.jobId, attempt: original.attempt } : {}),
    });
  }
  select(`cpp-bootstrap-${options.target}`, 'bootstrap', required[1]);
  RETAINED_CPP_DEVICES.forEach(([, device], index) => {
    select(
      `screenshot-fixtures-cpp-capture-${options.target}-en-US-${device}`,
      'recording',
      required[index + 2],
      device,
    );
    select(`ios-cpp-${options.target}-cpp-capture-en-US-${device}`, 'native', required[index + 2], device);
  });
  if (new Set(selected.map((artifact) => artifact.id)).size !== selected.length) return fail();
  {
    const relevant = artifacts.filter((artifact) =>
      /^(?:cpp-bootstrap-|ios-cpp-|screenshot-fixtures-cpp-capture-)/.test(String(artifact.name)),
    );
    const known = [...selected, ...(retry?.history.excludedArtifacts ?? [])];
    if (
      known.length !== relevant.length ||
      new Set(known.map((artifact) => artifact.id)).size !== known.length ||
      relevant.some((artifact) => !known.some((entry) => entry.id === artifact.id))
    )
      return fail();
    retry?.history.excludedArtifacts.sort((left, right) => left.id - right.id);
  }
  const producer: Producer = {
    runId: options.runId,
    attempt,
    producerSha,
    preparerSha: options.preparerSha,
    jobIds: required.map((job) => originals.get(job.name)?.jobId ?? Number(job.id)),
    artifacts: selected,
    ...(retry ? { retryHistory: retry.history } : {}),
    ...(compatibility.sourceManifestSha256 !== compatibility.currentManifestSha256
      ? { captureSource, compatibility }
      : {}),
  };
  verifiedInputs.set(producer, {
    sha256: hash(
      canonicalJson({ run, workflow, jobs, artifacts, priorAttempts: retry?.history.attempts ?? [], captureSource }),
    ),
    artifactSizes: new Map(
      selected.map((artifact) => [
        artifact.id,
        Number(artifacts.find((entry) => entry.id === artifact.id)!.size_in_bytes),
      ]),
    ),
  });
  return producer;
}

function scenarioHash(capture: unknown): string {
  if (!object(capture) || !object(capture.cpp) || !object(capture.cpp.scenes)) return fail();
  const copy = structuredClone(capture);
  const cpp = copy.cpp as Record<string, unknown>;
  delete cpp.boardPhotoAssets;
  const scenes = cpp.scenes as Record<string, unknown>;
  if (object(scenes.search) && object(scenes.search.gradeFilter)) {
    // Match the merger's scene identity contract. Every recorded count is
    // independently proved before this normalized identity is compared.
    scenes.search.gradeFilter.expectedCount = 0;
    delete scenes.search.gradeFilter.proof;
  }
  return hash(canonicalJson(copy));
}
function identityHash(manifest: ScreenshotFixtureManifest): string {
  return hash(
    canonicalJson({
      accountEmail: manifest.accountEmail,
      accountUserId: manifest.accountUserId,
      flow: manifest.flow,
      upstream: manifest.upstream,
    }),
  );
}
export function verifyRetainedCppSource(directory: string, target: CppTarget): ScreenshotFixtureManifest {
  try {
    const manifest = readScreenshotFixtureManifest(directory);
    if (!manifest || manifest.flow !== 'app-store-cpp' || manifest.capture?.cpp?.target !== target) return fail();
    const expected = [
      'manifest.json',
      ...manifest.graphql.map((entry) => entry.file),
      ...manifest.static.map((entry) => entry.file),
    ].sort();
    if (canonicalJson(listFixtureFiles(directory)) !== canonicalJson(expected)) return fail();
    const fixtures = manifest.graphql.map(
      (entry) => json(readFileSync(join(directory, entry.file))) as GraphqlFixtureFile,
    );
    resolveCppDetailReads(manifest, fixtures);
    for (const entry of manifest.static)
      if (readFileSync(join(directory, entry.file)).length !== entry.bytes) return fail();
    return manifest;
  } catch {
    return fail();
  }
}

/** Verify actual native PNGs and their existing record-mode metadata, never relabel their commit. */
export function verifyRetainedCppNative(
  directory: string,
  device: string,
  manifest: ScreenshotFixtureManifest,
  captureSource?: CppCaptureSourceContext,
): void {
  try {
    const target = manifest.capture!.cpp!.target;
    const compatibility = captureSource ? verifyCppCaptureCompatibility(target, captureSource) : undefined;
    const page = readCppPage(target);
    const rawFolder = join(directory, 'raw-screenshots', 'en-US', device);
    const framedFolder = join(directory, 'screenshots', 'en-US', device);
    const filenames = listFixtureFiles(directory);
    const rawNames = filenames
      .filter((name) => name.startsWith(`raw-screenshots/en-US/${device}/`) && name.endsWith('.png'))
      .map((name) => name.split('/').at(-1)!);
    const recipes = resolveCppRecipes(page, device, rawNames);
    for (const filename of rawNames) {
      const native = readFileSync(join(rawFolder, filename));
      if (native.length < DEFAULT_MIN_BYTES || findOffenders(device, [{ name: filename, buffer: native }]).length)
        return fail();
    }
    const expected = [
      `raw-screenshots/en-US/${device}/cpp-capture.json`,
      `screenshots/en-US/${device}/presentation.json`,
      ...(existsSync(join(framedFolder, 'contact-sheet.jpg')) ? [`screenshots/en-US/${device}/contact-sheet.jpg`] : []),
      ...rawNames.map((name) => `raw-screenshots/en-US/${device}/${name}`),
      ...recipes.map(({ output }) => `screenshots/en-US/${device}/${output}`),
    ].sort();
    if (canonicalJson(filenames) !== canonicalJson(expected)) return fail();
    const captured = json(readFileSync(join(rawFolder, 'cpp-capture.json')));
    const presentation = json(readFileSync(join(framedFolder, 'presentation.json')));
    if (
      !object(captured) ||
      captured.target !== target ||
      captured.verified !== false ||
      canonicalJson(captured.coverage) !== canonicalJson(manifest.capture!.cpp) ||
      !object(presentation) ||
      presentation.version !== 1 ||
      presentation.locale !== 'en-US' ||
      !object(presentation.cpp) ||
      presentation.cpp.target !== target ||
      presentation.cpp.manifestSha256 !==
        (compatibility?.sourceManifestSha256 ?? hash(readFileSync(CPP_MANIFEST_PATH))) ||
      !object(presentation.files) ||
      canonicalJson(Object.keys(presentation.files).sort()) !==
        canonicalJson(recipes.map(({ output }) => output).sort())
    )
      return fail();
    for (const recipe of recipes) {
      const metadata = presentation.files[recipe.output];
      const framed = readFileSync(join(framedFolder, recipe.output));
      if (
        !object(metadata) ||
        metadata.framedSha256 !== hash(framed) ||
        findOffenders(device, [{ name: recipe.output, buffer: framed }]).length
      )
        return fail();
      const sources = recipe.sources.length > 1 ? metadata.sources : { [recipe.sources[0]]: metadata };
      if (!object(sources) || canonicalJson(Object.keys(sources).sort()) !== canonicalJson([...recipe.sources].sort()))
        return fail();
      for (const filename of recipe.sources) {
        const native = readFileSync(join(rawFolder, filename));
        const source = sources[filename];
        if (
          !object(source) ||
          source.rawSha256 !== hash(native) ||
          source.rawBytes !== native.length ||
          native.length < DEFAULT_MIN_BYTES ||
          findOffenders(device, [{ name: filename, buffer: native }]).length
        )
          return fail();
      }
    }
  } catch {
    return fail();
  }
}

export async function downloadRetainedCppRecord(options: RetainedCppOptions, client: RetainedCppClient): Promise<void> {
  if (existsSync(options.out) || existsSync(options.receipt)) return fail();
  const producer = verifyRetainedCppProducer(options, client);
  const scratch = mkdtempSync(join(tmpdir(), 'cpp-retained-'));
  try {
    const artifactDirectories = new Map<number, string>();
    for (const artifact of producer.artifacts) {
      const bytes = client.bytes(`repos/${options.repository}/actions/artifacts/${artifact.id}/zip`);
      if (
        bytes.length > 128 * 1024 * 1024 ||
        bytes.length !== verifiedInputs.get(producer)?.artifactSizes.get(artifact.id) ||
        `sha256:${hash(bytes)}` !== artifact.digest
      )
        return fail();
      const zip = join(scratch, `${artifact.id}.zip`);
      writeFileSync(zip, bytes);
      const directory = join(scratch, String(artifact.id));
      extractArtifactZip(zip, directory);
      artifactDirectories.set(artifact.id, directory);
    }
    const bootstrap = producer.artifacts.find((artifact) => artifact.kind === 'bootstrap')!;
    const bootstrapDirectory = artifactDirectories.get(bootstrap.id)!;
    const scenarios = listFixtureFiles(bootstrapDirectory).filter(
      (name) => name.split('/').at(-1) === 'cpp-scenario.json',
    );
    if (scenarios.length !== 1) return fail();
    const originalScenarioHash = scenarioHash(json(readFileSync(join(bootstrapDirectory, scenarios[0]))));
    const recordings = join(scratch, 'recordings');
    mkdirSync(recordings);
    let originalIdentityHash = '';
    const manifests: Record<string, string> = {};
    const nativeInventories: Record<string, string> = {};
    for (const artifact of producer.artifacts.filter((artifact) => artifact.kind === 'recording')) {
      const directory = artifactDirectories.get(artifact.id)!;
      const manifest = verifyRetainedCppSource(directory, options.target);
      if (
        scenarioHash(manifest.capture) !== originalScenarioHash ||
        (originalIdentityHash && identityHash(manifest) !== originalIdentityHash)
      )
        return fail();
      originalIdentityHash = identityHash(manifest);
      const native = producer.artifacts.find((entry) => entry.kind === 'native' && entry.device === artifact.device)!;
      const nativeDirectory = artifactDirectories.get(native.id)!;
      verifyRetainedCppNative(nativeDirectory, artifact.device!, manifest, producer.captureSource);
      nativeInventories[artifact.device!] = hash(
        canonicalJson(
          Object.fromEntries(
            listFixtureFiles(nativeDirectory).map((name) => [name, hash(readFileSync(join(nativeDirectory, name)))]),
          ),
        ),
      );
      manifests[artifact.device!] = hash(readFileSync(join(directory, 'manifest.json')));
      renameSync(directory, join(recordings, artifact.device!));
    }
    const readback = verifyRetainedCppProducer(options, client);
    if (
      !verifiedInputs.has(producer) ||
      verifiedInputs.get(readback)?.sha256 !== verifiedInputs.get(producer)?.sha256 ||
      canonicalJson(readback) !== canonicalJson(producer)
    )
      return fail();
    mkdirSync(resolve(options.out, '..'), { recursive: true });
    renameSync(recordings, options.out);
    mkdirSync(resolve(options.receipt, '..'), { recursive: true });
    writeFileSync(
      options.receipt,
      JSON.stringify(
        {
          ...producer,
          target: options.target,
          scenarioSha256: originalScenarioHash,
          identitySha256: originalIdentityHash,
          manifestSha256: manifests,
          nativeInventorySha256: nativeInventories,
        },
        null,
        2,
      ) + '\n',
    );
  } catch {
    rmSync(options.out, { recursive: true, force: true });
    rmSync(options.receipt, { force: true });
    return fail();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function verifyRetainedCppMerged(directory: string, receiptPath: string): void {
  const receipt = json(readFileSync(receiptPath));
  if (!object(receipt) || !isCppTarget(receipt.target)) return fail();
  if (receipt.captureSource !== undefined || receipt.compatibility !== undefined) {
    if (
      !object(receipt.captureSource) ||
      receipt.captureSource.sourceSha !== receipt.producerSha ||
      !object(receipt.compatibility)
    )
      return fail();
    const compatibility = verifyCppCaptureCompatibility(
      receipt.target,
      receipt.captureSource as unknown as CppCaptureSourceContext,
    );
    if (canonicalJson(compatibility) !== canonicalJson(receipt.compatibility)) return fail();
  }
  const manifest = verifyRetainedCppSource(directory, receipt.target);
  if (scenarioHash(manifest.capture) !== receipt.scenarioSha256 || identityHash(manifest) !== receipt.identitySha256)
    return fail();
}

function createClient(): RetainedCppClient {
  const run = (args: string[]): Buffer =>
    execFileSync('gh', ['api', ...args], {
      maxBuffer: 128 * 1024 * 1024,
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  return {
    json: (path) => json(run([path])),
    pages: (path, field) => list(json(run(['--paginate', '--slurp', path]))).flatMap((page) => list(page[field])),
    // Logs contain ANSI escapes and ZIPs are arbitrary bytes. Capture them only
    // into a Buffer for verification; never render this raw content in a terminal.
    bytes: (path) => run(['--allow-escape-sequences', path]),
    isAncestor: (producerSha, preparerSha) => {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', producerSha, preparerSha], { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    },
    isCommit: (commit) => {
      try {
        return execFileSync('git', ['cat-file', '-t', commit], { encoding: 'utf8', stdio: 'pipe' }).trim() === 'commit';
      } catch {
        return false;
      }
    },
    source: (producerSha, path) => execFileSync('git', ['show', `${producerSha}:${path}`], { stdio: 'pipe' }),
    workflow: (producerSha) =>
      execFileSync('git', ['show', `${producerSha}:${WORKFLOW_PATH}`], { encoding: 'utf8', stdio: 'pipe' }),
  };
}
export async function main(argv: string[]): Promise<void> {
  try {
    if (argv.length === 4 && argv[0] === '--merged' && argv[2] === '--receipt') {
      verifyRetainedCppMerged(resolve(argv[1]), resolve(argv[3]));
      return;
    }
    if (
      argv.length !== 4 ||
      argv[0] !== '--out' ||
      argv[2] !== '--receipt' ||
      !isCppTarget(process.env.CPP_TARGET) ||
      !/^[1-9]\d*$/.test(process.env.CPP_RECORD_RUN_ID ?? '')
    )
      return fail();
    if (
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim() !== process.env.SOURCE_SHA
    )
      return fail();
    await downloadRetainedCppRecord(
      {
        repository: process.env.GITHUB_REPOSITORY ?? '',
        runId: Number(process.env.CPP_RECORD_RUN_ID),
        target: process.env.CPP_TARGET,
        preparerSha: process.env.SOURCE_SHA ?? '',
        out: resolve(argv[1]),
        receipt: resolve(argv[3]),
      },
      createClient(),
    );
  } catch {
    return fail();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(() => {
    console.error('Retained CPP recording failed source or artifact verification');
    process.exitCode = 1;
  });
