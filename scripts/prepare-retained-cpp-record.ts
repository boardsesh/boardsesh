/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { extractArtifactZip } from './mobile-ota-stable-artifacts';
import { findOffenders } from './assert-screenshot-dimensions';
import { DEFAULT_MIN_BYTES } from './assert-screenshot-content';
import { resolveCppDetailReads } from './lib/cpp-detail-coverage';
import { readScreenshotFixtureManifest, listFixtureFiles } from './lib/screenshot-backend';
import { canonicalJson, type GraphqlFixtureFile, type ScreenshotFixtureManifest } from './lib/screenshot-fixtures';
import { CPP_MANIFEST_PATH, isCppTarget, readCppPage, resolveCppRecipes, type CppTarget } from './lib/screenshot-cpp';

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
}
interface Producer {
  runId: number;
  attempt: number;
  producerSha: string;
  preparerSha: string;
  jobIds: number[];
  artifacts: SelectedArtifact[];
}

/** Only the same immutable, first-attempt producer and its four successful native jobs qualify. */
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
    run.run_attempt !== 1 ||
    !sha(run.head_sha) ||
    !client.isAncestor(run.head_sha, options.preparerSha)
  )
    return fail();
  const producerSha = run.head_sha;
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
  const jobs = client.pages(`${prefix}/runs/${options.runId}/attempts/1/jobs?per_page=100`, 'jobs');
  if (jobs.some((job) => !id(job.id) || job.run_attempt !== 1 || job.status !== 'completed')) return fail();
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
    const matches = artifacts.filter((artifact) => artifact.name === name);
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
    selected.push({ id: artifact.id, name, digest: artifact.digest, kind, ...(device ? { device } : {}) });
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
  return {
    runId: options.runId,
    attempt: 1,
    producerSha,
    preparerSha: options.preparerSha,
    jobIds: required.map((job) => Number(job.id)),
    artifacts: selected,
  };
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
export function verifyRetainedCppNative(directory: string, device: string, manifest: ScreenshotFixtureManifest): void {
  try {
    const target = manifest.capture!.cpp!.target;
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
      presentation.cpp.manifestSha256 !== hash(readFileSync(CPP_MANIFEST_PATH)) ||
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
      if (bytes.length > 128 * 1024 * 1024 || `sha256:${hash(bytes)}` !== artifact.digest) return fail();
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
      verifyRetainedCppNative(nativeDirectory, artifact.device!, manifest);
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
