import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { ACCEPTED_SIZES } from '../assert-screenshot-dimensions';
import { CPP_MANIFEST_PATH, cppCaptureNames, readCppPage } from '../lib/screenshot-cpp';
import type { ScreenshotFixtureManifest } from '../lib/screenshot-fixtures';
import * as snapshots from '../lib/screenshot-fixture-snapshot';
import * as records from '../prepare-retained-cpp-record';
import * as readiness from '../lib/screenshot-cpp';
import * as detailCoverage from '../lib/cpp-detail-coverage';
import * as capture from '../mobile-screenshots';
import {
  createReplayClient,
  isReplayCapturePath,
  verifyReplayFixture,
  prepareRetainedReplay,
  replayHash,
  requireReviewedReceipt,
  verifyReplayProducer,
  verifyReplayShard,
  type ReplayClient,
  type ReplayOptions,
  type ReplayArtifact,
} from '../prepare-retained-cpp-replay';

const ROOT = process.cwd();
const trackedPaths = [
  '.github/workflows/mobile-screenshots-ios.yml',
  '.github/actions/ios-screenshot-shard/action.yml',
  'scripts/mobile-screenshots.ts',
  'scripts/frame-screenshots.ts',
  'scripts/lib/cpp-detail-coverage.ts',
  'scripts/lib/screenshot-presentation.ts',
  'app-stores/presentation/en-US.json',
  'packages/mobile/.maestro/app-store-cpp.yaml',
  'packages/mobile/src/lib/screenshot-climb-selection.ts',
  'packages/mobile/src/components/LayeredClimbImage.tsx',
  'packages/mobile/src/components/play-drawer/SwipeBoardCarousel.tsx',
  'packages/mobile/app/(tabs)/climbs/index.tsx',
  'packages/mobile/src/components/ScreenshotSmokeMarker.tsx',
  'packages/shared/board-render/src/index.ts',
  'package.json',
  'pnpm-lock.yaml',
  'vite.config.ts',
  'scripts/mobile-build-sim-app.ts',
  'scripts/mobile-ios-run.ts',
  'scripts/screenshot-sim.entitlements',
  'packages/mobile/app.config.ts',
  'packages/mobile/plugins/with-screenshot-dev-menu.js',
];
const runId = 1234;
const producerSha = 'a'.repeat(40);
const target = 'moonboard' as const;
const fixture = {
  version: 1 as const,
  url: 'https://example.test/immutable.json.gz',
  sha256: 'b'.repeat(64),
  bytes: 123,
  files: 1,
};
const manifest = {
  formatVersion: 1,
  flow: 'app-store-cpp',
  graphql: [],
  static: [],
  capture: { boards: ['one', 'two', 'three', 'four', 'five', 'six'], cpp: { target, scenes: {} } },
} as unknown as ScreenshotFixtureManifest;
const roots: string[] = [];
function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'cpp-replay-test-'));
  roots.push(root);
  return root;
}
function put(root: string, path: string, bytes: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function sample() {
  const options: ReplayOptions = {
    repository: 'boardsesh/boardsesh',
    runId,
    target,
    sourceSha: 'c'.repeat(40),
    repoRoot: ROOT,
    receipt: join(directory(), 'receipt.json'),
    stage: false,
  };
  const run = {
    id: runId,
    repository: { full_name: options.repository },
    head_repository: { full_name: options.repository },
    path: '.github/workflows/mobile-screenshots-ios.yml',
    workflow_id: 7,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    head_sha: producerSha,
  };
  const names = [
    'setup',
    'ios-build',
    'cpp-bootstrap',
    'cpp-prepare-record',
    'cpp-finalize',
    'cpp-create',
    'cpp-plan',
    'ios-finalize',
  ];
  const jobs = names.map((name, index) => ({
    id: index + 1,
    name,
    run_attempt: 1,
    status: 'completed',
    conclusion: index < 2 ? 'success' : 'skipped',
    started_at: '2026-10-14T00:00:00Z',
    completed_at: '2026-10-14T00:05:00Z',
  }));
  const artifacts: Array<Record<string, unknown>> = [];
  for (const locale of ['en-US', 'es', 'fr', 'de'])
    for (const [name, slug] of records.RETAINED_CPP_DEVICES) {
      jobs.push({ ...jobs[0], id: jobs.length + 1, name: `cpp-capture (${target}, ${locale}, ${name}, ${slug})` });
      artifacts.push({
        id: artifacts.length + 100,
        name: `ios-cpp-${target}-cpp-capture-${locale}-${slug}`,
        expired: false,
        digest: `sha256:${'d'.repeat(64)}`,
        created_at: '2026-10-14T00:04:00Z',
        workflow_run: { id: runId, head_sha: producerSha },
      });
    }
  const client: ReplayClient = {
    json: (path) =>
      path.includes('/workflows/') ? { id: 7, path: '.github/workflows/mobile-screenshots-ios.yml' } : run,
    pages: (_path, field) => (field === 'jobs' ? jobs : artifacts),
    bytes: () => {
      throw new Error('Unexpected download');
    },
    source: (_commit, path) => readFileSync(join(ROOT, path)),
    files: () => trackedPaths,
    isAncestor: () => true,
  };
  return { options, run, jobs, artifacts, client };
}

describe('original native replay provenance', () => {
  it('accepts exactly sixteen successful native replay shards, one immutable artifact each', () => {
    const source = sample();
    const proof = verifyReplayProducer(source.options, source.client);
    expect(proof.artifacts).toHaveLength(16);
    expect(proof.jobIds).toHaveLength(18);
    expect(proof.attempt).toBe(1);
  });
  it.each([
    [
      'foreign repository',
      (source: ReturnType<typeof sample>) => {
        source.run.head_repository.full_name = 'outsider/repo';
      },
    ],
    [
      'rerun',
      (source: ReturnType<typeof sample>) => {
        source.run.run_attempt = 2;
      },
    ],
    [
      'failed run',
      (source: ReturnType<typeof sample>) => {
        source.run.conclusion = 'failure';
      },
    ],
    [
      'incomplete native set',
      (source: ReturnType<typeof sample>) => {
        source.jobs.pop();
      },
    ],
    [
      'failed native job with uploaded images',
      (source: ReturnType<typeof sample>) => {
        source.jobs.at(-1)!.conclusion = 'failure';
      },
    ],
    [
      'record mode',
      (source: ReturnType<typeof sample>) => {
        source.jobs[3].conclusion = 'success';
      },
    ],
    [
      'producer already stages assets',
      (source: ReturnType<typeof sample>) => {
        source.jobs[4].conclusion = 'success';
      },
    ],
    [
      'ambiguous jobs',
      (source: ReturnType<typeof sample>) => {
        source.jobs.push({ ...source.jobs.at(-1)! });
      },
    ],
    [
      'missing artifact',
      (source: ReturnType<typeof sample>) => {
        source.artifacts.pop();
      },
    ],
    [
      'extra artifact',
      (source: ReturnType<typeof sample>) => {
        source.artifacts.push({ ...source.artifacts[0], id: 900 });
      },
    ],
    [
      'duplicate artifact id',
      (source: ReturnType<typeof sample>) => {
        source.artifacts[1].id = source.artifacts[0].id;
      },
    ],
    [
      'expired artifact',
      (source: ReturnType<typeof sample>) => {
        source.artifacts[0].expired = true;
      },
    ],
    [
      'unsigned archive',
      (source: ReturnType<typeof sample>) => {
        source.artifacts[0].digest = '';
      },
    ],
    [
      'other commit archive',
      (source: ReturnType<typeof sample>) => {
        source.artifacts[0].workflow_run = { id: runId, head_sha: 'f'.repeat(40) };
      },
    ],
    [
      'artifact outside job',
      (source: ReturnType<typeof sample>) => {
        source.artifacts[0].created_at = '2026-10-13T00:00:00Z';
      },
    ],
    [
      'mixed attempt',
      (source: ReturnType<typeof sample>) => {
        source.jobs.at(-1)!.run_attempt = 2;
      },
    ],
  ] as const)('rejects %s before download', (_name, mutate) => {
    const source = sample();
    mutate(source);
    expect(() => verifyReplayProducer(source.options, source.client)).toThrow();
  });
  it('rejects divergent source ancestry and changed capture code', () => {
    const source = sample();
    source.client.isAncestor = () => false;
    expect(() => verifyReplayProducer(source.options, source.client)).toThrow();
    source.client.isAncestor = () => true;
    source.client.source = (_commit, path) =>
      Buffer.from(readFileSync(join(ROOT, path), 'utf8').replace('--fixtures "$FIXTURES_INPUT"', '--fixtures record'));
    expect(() => verifyReplayProducer(source.options, source.client)).toThrow();
  });
  it.each(trackedPaths.filter(isReplayCapturePath))(
    'rejects an independently changed capture gate or presentation dependency: %s',
    (changedPath) => {
      const source = sample();
      source.client.source = (_commit, path) =>
        Buffer.concat([readFileSync(join(ROOT, path)), ...(path === changedPath ? [Buffer.from('changed')] : [])]);
      expect(() => verifyReplayProducer(source.options, source.client)).toThrow();
    },
  );
  it('accepts historical identical capture code without importing newly added staging tooling', () => {
    const source = sample();
    const importerPaths = [
      'scripts/prepare-retained-cpp-replay.ts',
      'scripts/__tests__/prepare-retained-cpp-replay.test.ts',
      '.github/workflows/mobile-cpp-retained-replay.yml',
    ];
    source.client.files = (commit) => [...trackedPaths, ...(commit === producerSha ? [] : importerPaths)];
    expect(verifyReplayProducer(source.options, source.client).artifacts).toHaveLength(16);
    for (const path of importerPaths) expect(isReplayCapturePath(path)).toBe(false);
  });
  it('rejects an added or removed capture gate file', () => {
    const source = sample();
    source.client.files = (commit) =>
      trackedPaths.filter((path) => commit !== producerSha || path !== 'scripts/lib/cpp-detail-coverage.ts');
    expect(() => verifyReplayProducer(source.options, source.client)).toThrow();
  });
  it('reads the committed native archives larger than four MiB through the real bounded source client', () => {
    const client = createReplayClient();
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const archives = client.files(commit).filter((path) => isReplayCapturePath(path) && path.endsWith('.a'));
    const large = archives.filter((path) => readFileSync(join(ROOT, path)).length > 4 * 1024 * 1024);
    expect(large.length).toBeGreaterThan(0);
    for (const path of large)
      expect(replayHash(client.source(commit, path))).toBe(replayHash(readFileSync(join(ROOT, path))));
  });
  it('rejects source checkout changes in the producer workflow', () => {
    const source = sample();
    source.client.source = (_commit, path) =>
      Buffer.from(
        readFileSync(join(ROOT, path), 'utf8').replaceAll(
          'ref: ${{ needs.setup.outputs.source_sha }}',
          'ref: unrelated',
        ),
      );
    expect(() => verifyReplayProducer(source.options, source.client)).toThrow();
  });
});

function png(device: string, marker: string): Buffer {
  const bytes = Buffer.alloc(65536, 1);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.write('IHDR', 12);
  const { width, height } = ACCEPTED_SIZES[device][0];
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.write(marker, 24);
  return bytes;
}
function writeShard(root: string, artifact: ReplayArtifact): void {
  const page = readCppPage(target);
  const locales: Record<string, string[]> = {
    'en-US': ['en-US'],
    es: ['es-ES', 'es-MX'],
    fr: ['fr-FR'],
    de: ['de-DE'],
  };
  const recipes = page.recipes[artifact.device.startsWith('ipad') ? 'ipad' : 'phone'];
  const sources = Object.fromEntries(
    cppCaptureNames(page, artifact.device).map((name) => [name, png(artifact.device, name)]),
  );
  for (const locale of locales[artifact.locale]) {
    const raw = `raw-screenshots/${locale}/${artifact.device}`;
    const framed = `screenshots/${locale}/${artifact.device}`;
    put(
      root,
      `${raw}/cpp-capture.json`,
      JSON.stringify({ target, verified: true, fixtureSha256: fixture.sha256, coverage: manifest.capture!.cpp }),
    );
    for (const [name, bytes] of Object.entries(sources)) put(root, `${raw}/${name}`, bytes);
    const files: Record<string, unknown> = {};
    for (const recipe of recipes) {
      const bytes = png(artifact.device, recipe.output);
      put(root, `${framed}/${recipe.output}`, bytes);
      const provenance = Object.fromEntries(
        recipe.sources.map((name) => [name, { rawBytes: sources[name].length, rawSha256: replayHash(sources[name]) }]),
      );
      files[recipe.output] = {
        ...provenance[recipe.sources[0]],
        framedSha256: replayHash(bytes),
        ...(recipe.sources.length > 1 ? { sources: provenance } : {}),
      };
    }
    put(
      root,
      `${framed}/presentation.json`,
      JSON.stringify({
        version: 1,
        locale: artifact.locale,
        cpp: { target, fixtureSha256: fixture.sha256, manifestSha256: replayHash(readFileSync(CPP_MANIFEST_PATH)) },
        files,
      }),
    );
  }
}
const archives = new Map<number, Buffer>();
let validArtifacts: ReplayArtifact[];
beforeAll(() => {
  const source = sample();
  validArtifacts = verifyReplayProducer(source.options, source.client).artifacts;
  for (const artifact of validArtifacts) {
    const root = directory();
    writeShard(root, artifact);
    const zip = join(directory(), 'shard.zip');
    execFileSync('python3', [
      '-c',
      'import pathlib,sys,zipfile\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED) as archive:\n for path in sorted(root.rglob("*")):\n  if path.is_file(): archive.write(path,path.relative_to(root))',
      root,
      zip,
    ]);
    archives.set(artifact.id, readFileSync(zip));
  }
});

describe('replay pixels and reviewed byte binding', () => {
  it.each(['record', 'fixture', 'coverage', 'extra', 'missing', 'spanish'])(
    'rejects %s shard metadata/content before assembly',
    (kind) => {
      const artifact = validArtifacts.find((entry) => entry.locale === (kind === 'spanish' ? 'es' : 'en-US'))!;
      const root = directory();
      writeShard(root, artifact);
      const locale = kind === 'spanish' ? 'es-ES' : 'en-US';
      const capturePath = join(root, 'raw-screenshots', locale, artifact.device, 'cpp-capture.json');
      const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as Record<string, unknown>;
      if (kind === 'record') capture.verified = false;
      if (kind === 'fixture') capture.fixtureSha256 = 'e'.repeat(64);
      if (kind === 'coverage') capture.coverage = { target: 'kilter' };
      writeFileSync(capturePath, JSON.stringify(capture));
      if (kind === 'extra') put(root, 'screenshots/other.png', 'extra');
      if (kind === 'missing') rmSync(capturePath);
      if (kind === 'spanish') writeFileSync(capturePath, JSON.stringify(capture, null, 2));
      expect(() => verifyReplayShard(root, artifact, target, fixture, manifest)).toThrow();
    },
  );
  it('requires a digest of the exact canonical receipt bytes before staging', () => {
    const receipt = { inventory: { 'a.png': { sha256: 'abc' } }, runId };
    const expected = requireReviewedReceipt(receipt, undefined, false);
    expect(() => requireReviewedReceipt(receipt, undefined, true)).toThrow();
    expect(() => requireReviewedReceipt({ ...receipt, runId: 999 }, expected, true)).toThrow();
    expect(requireReviewedReceipt(receipt, expected, true)).toBe(expected);
  });
  function preparedSource() {
    const source = sample();
    const root = directory();
    source.options.repoRoot = root;
    source.options.receipt = join(root, 'receipt.json');
    source.options.fixtureSnapshot = 'https://example.test/reference.json';
    for (const path of ['.github/workflows/mobile-screenshots-ios.yml', ...trackedPaths.filter(isReplayCapturePath)])
      put(root, path, readFileSync(join(ROOT, path)));
    const fixtureRoot = join(root, 'fixtures');
    put(fixtureRoot, 'manifest.json', JSON.stringify(manifest));
    vi.spyOn(snapshots, 'fetchFixtureSnapshotReference').mockResolvedValue(fixture);
    vi.spyOn(snapshots, 'ensureScreenshotFixtures').mockResolvedValue(fixtureRoot);
    vi.spyOn(records, 'verifyRetainedCppSource').mockReturnValue(manifest);
    vi.spyOn(detailCoverage, 'resolveCppDetailReads').mockReturnValue([]);
    vi.spyOn(capture, 'readIosCampaignBoards').mockReturnValue([]);
    vi.spyOn(readiness, 'assertCppCaptureReady').mockImplementation(() => {});
    for (const artifact of source.artifacts)
      artifact.digest = `sha256:${replayHash(archives.get(Number(artifact.id))!)}`;
    source.client.bytes = (path) => archives.get(Number(path.split('/').at(-2)))!;
    return source;
  }
  it('assembles 180 exact images, verifies native sources, and permits the same reviewed bytes on retry', async () => {
    const first = preparedSource();
    const digest = await prepareRetainedReplay(first.options, first.client);
    const receipt = readFileSync(first.options.receipt);
    expect(replayHash(receipt)).toBe(digest);
    const parsed = JSON.parse(receipt.toString()) as {
      screenshots: number;
      inventory: Record<string, { sha256: string }>;
    };
    expect(parsed.screenshots).toBe(180);
    for (const [path, proof] of Object.entries(parsed.inventory))
      expect(replayHash(readFileSync(join(first.options.repoRoot, 'app-stores/apple/cpp', target, path)))).toBe(
        proof.sha256,
      );
    const second = preparedSource();
    second.options.stage = true;
    second.options.expectedReceipt = digest;
    expect(await prepareRetainedReplay(second.options, second.client)).toBe(digest);
  });
  it('rejects replaced ZIP bytes, a changed reviewed receipt and a late producer rerun', async () => {
    const corrupt = preparedSource();
    corrupt.client.bytes = () => Buffer.from('replaced ZIP');
    await expect(prepareRetainedReplay(corrupt.options, corrupt.client)).rejects.toThrow();
    const wrong = preparedSource();
    wrong.options.stage = true;
    wrong.options.expectedReceipt = 'f'.repeat(64);
    await expect(prepareRetainedReplay(wrong.options, wrong.client)).rejects.toThrow();
    expect(existsSync(join(wrong.options.repoRoot, 'app-stores/apple/cpp', target))).toBe(false);
    const late = preparedSource();
    let runReads = 0;
    const original = late.client.json.bind(late.client);
    late.client.json = (path) => {
      if (path.endsWith(`/runs/${runId}`) && ++runReads > 1) return { ...late.run, run_attempt: 2 };
      return original(path);
    };
    await expect(prepareRetainedReplay(late.options, late.client)).rejects.toThrow();
    expect(existsSync(late.options.receipt)).toBe(false);
  });
  it.each([false, true])('restores the prior fixture pin after receipt mismatch (existing: %s)', async (existing) => {
    const source = preparedSource();
    const reference = join(source.options.repoRoot, 'app-stores/apple/cpp-fixtures/moonboard.json');
    const prior = '{"unchanged":"original bytes"}\n';
    if (existing) put(source.options.repoRoot, 'app-stores/apple/cpp-fixtures/moonboard.json', prior);
    source.options.stage = true;
    source.options.expectedReceipt = 'f'.repeat(64);
    await expect(prepareRetainedReplay(source.options, source.client)).rejects.toThrow();
    expect(existsSync(reference)).toBe(existing);
    if (existing) expect(readFileSync(reference, 'utf8')).toBe(prior);
  });
  it('requires every native detail response, including the twenty-first', () => {
    const source = preparedSource();
    const fixtureRoot = join(source.options.repoRoot, 'fixtures');
    const reads = Array.from({ length: 21 }, (_, index) => ({
      operationName: 'GetBetaLinks',
      query: 'query',
      variables: {},
      variablesHash: String(index),
      documentHash: 'hash',
    }));
    const completeManifest = {
      ...manifest,
      graphql: reads.slice(0, 20).map((read, index) => ({ ...read, file: `graphql/${index}.json` })),
    };
    for (const entry of completeManifest.graphql) put(fixtureRoot, entry.file, JSON.stringify(entry));
    vi.spyOn(records, 'verifyRetainedCppSource').mockReturnValue(completeManifest);
    vi.spyOn(detailCoverage, 'resolveCppDetailReads').mockReturnValue(reads);
    expect(() => verifyReplayFixture(fixtureRoot, target)).toThrow('failed source, native replay');
    expect(readiness.assertCppCaptureReady).not.toHaveBeenCalled();
  });
  it('runs current board/scene readiness even after structural fixture verification succeeds', () => {
    const source = preparedSource();
    vi.mocked(readiness.assertCppCaptureReady).mockRestore();
    expect(() => verifyReplayFixture(join(source.options.repoRoot, 'fixtures'), target)).toThrow(
      'six genuine recorded board names',
    );
  });
  it('rejects path traversal even when the malicious ZIP digest matches GitHub metadata', async () => {
    const source = preparedSource();
    const zip = join(directory(), 'bad.zip');
    execFileSync('python3', [
      '-c',
      'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as archive: archive.writestr("../escape.png","bad")',
      zip,
    ]);
    const bytes = readFileSync(zip);
    source.artifacts[0].digest = `sha256:${replayHash(bytes)}`;
    source.client.bytes = () => bytes;
    await expect(prepareRetainedReplay(source.options, source.client)).rejects.toThrow();
    expect(existsSync(source.options.receipt)).toBe(false);
  });
});

describe('workflow isolation', () => {
  it('uses trusted main, fixed stage-assets, no verify secrets, and the existing writer group only for staging', () => {
    const workflow = parse(readFileSync('.github/workflows/mobile-cpp-retained-replay.yml', 'utf8')) as {
      concurrency: { group: string; 'cancel-in-progress': boolean };
      jobs: Record<
        string,
        {
          if: string;
          environment?: string;
          steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }>;
        }
      >;
    };
    expect(workflow.concurrency.group).toContain("inputs.mode == 'stage-assets' && 'mobile-screenshots-ios'");
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    for (const name of ['verify', 'stage']) expect(workflow.jobs[name].if).toContain("github.ref == 'refs/heads/main'");
    expect(JSON.stringify(workflow.jobs.verify)).not.toContain('secrets.');
    expect(workflow.jobs.verify.environment).toBeUndefined();
    expect(JSON.stringify(workflow.jobs.validate)).not.toContain('secrets.');
    expect(workflow.jobs.stage.environment).toBe('Production');
    const steps = workflow.jobs.stage.steps;
    const verify = steps.findIndex((step) => step.run?.includes('prepare-retained-cpp-replay.ts'));
    const writer = steps.findIndex((step) => step.uses === './.github/actions/asc-cpp');
    expect(verify).toBeGreaterThan(-1);
    expect(writer).toBeGreaterThan(verify);
    expect(steps[writer].with?.action).toBe('stage-assets');
    expect(steps[writer].with?.['keyword-ids']).toBe('');
    expect(JSON.stringify(workflow)).not.toContain('ios-screenshot-shard');
  });
});
