import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { ACCEPTED_SIZES } from '../assert-screenshot-dimensions';
import { CPP_MANIFEST_PATH, cppCaptureNames, readCppPage } from '../lib/screenshot-cpp';
import { canonicalJson, type ScreenshotFixtureManifest } from '../lib/screenshot-fixtures';
import * as snapshots from '../lib/screenshot-fixture-snapshot';
import * as records from '../prepare-retained-cpp-record';
import * as readiness from '../lib/screenshot-cpp';
import * as detailCoverage from '../lib/cpp-detail-coverage';
import * as logbookCoverage from '../lib/cpp-logbook-coverage';
import * as capture from '../mobile-screenshots';
import {
  createReplayClient,
  isReplayCapturePath,
  isReviewedShowcasePair,
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
  'app-stores/apple/custom-product-pages.json',
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
  'packages/mobile/src/components/play-drawer/QueueList.tsx',
  'packages/mobile/src/providers/queue-provider.tsx',
  'packages/mobile/src/data/changelog.generated.json',
  'packages/mobile/src/components/offline-sync-bridge.tsx',
  'packages/mobile/src/lib/graphql/hooks/use-followed-authors.ts',
  'packages/mobile/src/lib/graphql/author-query-invalidation.ts',
  'packages/mobile/.maestro/showcase/crew-join.yaml',
  'packages/mobile/.maestro/showcase/crew-start.yaml',
  'packages/mobile/.maestro/showcase/crew.yaml',
  'packages/mobile/.maestro/showcase/session-end.yaml',
  'scripts/lib/showcase-video/record.ts',
  'scripts/lib/showcase-video/render.ts',
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

function retrySource(attempts = 2) {
  const source = sample();
  source.run.run_attempt = attempts;
  const histories = new Map<number, Array<Record<string, unknown>>>();
  const timestamp = (attempt: number, minute: number) =>
    `2026-10-14T${String(attempt - 1).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    histories.set(
      attempt,
      source.jobs.map((job, index) => {
        const retriedCell = index === source.jobs.length - 1;
        const executedAttempt = retriedCell ? attempt : 1;
        const conclusion = retriedCell && attempt < attempts ? 'failure' : job.conclusion;
        return {
          ...job,
          id: job.id + (attempt - 1) * 100,
          run_id: runId,
          run_attempt: attempt,
          head_sha: producerSha,
          conclusion,
          started_at: timestamp(executedAttempt, 0),
          completed_at: timestamp(executedAttempt, 5),
          steps:
            conclusion === 'skipped'
              ? []
              : [
                  {
                    name: job.name.startsWith('cpp-capture') ? 'Capture target-specific native scenes' : job.name,
                    number: 1,
                    status: 'completed',
                    conclusion,
                    started_at: timestamp(executedAttempt, 1),
                    completed_at: timestamp(executedAttempt, 4),
                  },
                ],
        };
      }),
    );
  }
  const latestArtifact = source.artifacts.at(-1)!;
  latestArtifact.created_at = timestamp(attempts, 4);
  for (let attempt = 1; attempt < attempts; attempt++)
    source.artifacts.push({ ...latestArtifact, id: 1000 + attempt, created_at: timestamp(attempt, 4) });
  source.client.pages = (path, field) => {
    if (field === 'artifacts') return source.artifacts;
    const attempt = Number(path.match(/\/attempts\/(\d+)\/jobs/)?.[1]);
    return histories.get(attempt) ?? [];
  };
  return { ...source, histories };
}

describe('original native replay provenance', () => {
  it('accepts exactly sixteen successful native replay shards, one immutable artifact each', () => {
    const source = sample();
    const proof = verifyReplayProducer(source.options, source.client);
    expect(proof.artifacts).toHaveLength(16);
    expect(proof.jobIds).toHaveLength(18);
    expect(proof.attempt).toBe(1);
    expect(Object.keys(proof).sort()).toEqual(
      ['runId', 'attempt', 'producerSha', 'jobIds', 'artifacts', 'captureContractSha256'].sort(),
    );
  });
  it.each([
    [
      'foreign repository',
      (source: ReturnType<typeof sample>) => {
        source.run.head_repository.full_name = 'outsider/repo';
      },
    ],
    [
      'rerun without complete original execution history',
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
  function changedRuntime(paths = ['packages/mobile/src/components/play-drawer/QueueList.tsx']) {
    const source = sample();
    const originalProof = verifyReplayProducer(source.options, source.client);
    source.options.repoRoot = directory();
    for (const path of trackedPaths) put(source.options.repoRoot, path, readFileSync(join(ROOT, path)));
    const files = paths.sort().map((path) => {
      const original = readFileSync(join(ROOT, path));
      const changed = Buffer.concat([original, Buffer.from('\n// reviewed runtime change\n')]);
      put(source.options.repoRoot, path, changed);
      return { path, producerSha256: replayHash(original), currentSha256: replayHash(changed) };
    });
    const drift = { version: 1, producerSha, files };
    source.options.approvedRuntimeDrift = replayHash(`${canonicalJson(drift)}\n`);
    return { ...source, originalProof, drift };
  }
  it('binds the exact accepted runtime delta while retaining the original capture contract', () => {
    const source = changedRuntime([
      'packages/mobile/src/providers/queue-provider.tsx',
      'packages/mobile/src/components/play-drawer/QueueList.tsx',
      'packages/mobile/src/data/changelog.generated.json',
    ]);
    const proof = verifyReplayProducer(source.options, source.client);
    expect(proof.captureContractSha256).toBe(source.originalProof.captureContractSha256);
    expect(proof.runtimeDrift).toEqual({ ...source.drift, approvedSha256: source.options.approvedRuntimeDrift });
    expect(() => requireReviewedReceipt(proof, replayHash(`${canonicalJson(source.originalProof)}\n`), true)).toThrow();
  });
  it.each([undefined, '', '0'.repeat(64), 'malformed'])(
    'rejects runtime drift without the exact approval: %s',
    (approval) => {
      const source = changedRuntime();
      source.options.approvedRuntimeDrift = approval;
      expect(() => verifyReplayProducer(source.options, source.client)).toThrow();
    },
  );
  it('rejects an approval token when the runtime is unchanged', () => {
    const source = sample();
    source.options.approvedRuntimeDrift = '0'.repeat(64);
    expect(() => verifyReplayProducer(source.options, source.client)).toThrow();
  });
  it('rejects later runtime edits and a different producer despite the prior approval', () => {
    const source = changedRuntime();
    put(source.options.repoRoot, source.drift.files[0].path, 'changed after review');
    expect(() => verifyReplayProducer(source.options, source.client)).toThrow();
    const otherProducer = changedRuntime();
    otherProducer.run.head_sha = 'f'.repeat(40);
    expect(() => verifyReplayProducer(otherProducer.options, otherProducer.client)).toThrow();
  });
  it.each([
    'packages/mobile/src/components/ScreenshotSmokeMarker.tsx',
    'packages/mobile/src/lib/screenshot-climb-selection.ts',
    'packages/mobile/src/components/LayeredClimbImage.tsx',
    'packages/mobile/app.config.ts',
    'scripts/lib/screenshot-presentation.ts',
    'app-stores/apple/custom-product-pages.json',
  ])('cannot approve drift in a capture gate, renderer, native config or manifest: %s', (path) => {
    expect(() => {
      const source = changedRuntime([path]);
      verifyReplayProducer(source.options, source.client);
    }).toThrow();
  });
  it('still requires all native jobs and source ancestry when runtime drift is approved', () => {
    const source = changedRuntime();
    source.jobs.pop();
    expect(() => verifyReplayProducer(source.options, source.client)).toThrow();
    const divergent = changedRuntime();
    divergent.client.isAncestor = () => false;
    expect(() => verifyReplayProducer(divergent.options, divergent.client)).toThrow();
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

describe('explicit presence and exact compatibility approval', () => {
  const added = 'packages/mobile/src/lib/graphql/author-query-invalidation.ts';
  const following = [
    'packages/mobile/src/components/offline-sync-bridge.tsx',
    'packages/mobile/src/lib/graphql/hooks/use-followed-authors.ts',
  ];
  function followingSource() {
    const source = sample();
    const priorPaths = trackedPaths.filter((path) => path !== added);
    source.client.files = () => priorPaths;
    const originalProof = verifyReplayProducer(source.options, source.client);
    source.client.files = (commit) => (commit === producerSha ? priorPaths : trackedPaths);
    source.options.repoRoot = directory();
    for (const path of trackedPaths) put(source.options.repoRoot, path, readFileSync(join(ROOT, path)));
    for (const path of following)
      put(
        source.options.repoRoot,
        path,
        Buffer.concat([readFileSync(join(ROOT, path)), Buffer.from('\n// reviewed\n')]),
      );
    const drift = {
      version: 2,
      producerSha,
      files: [...following, added].sort().map((path) => ({
        path,
        producerPresent: path !== added,
        producerSha256: path === added ? null : replayHash(readFileSync(join(ROOT, path))),
        currentPresent: true,
        currentSha256: replayHash(readFileSync(join(source.options.repoRoot, path))),
      })),
    };
    source.options.approvedRuntimeDrift = replayHash(`${canonicalJson(drift)}\n`);
    return { ...source, originalProof, drift };
  }
  it('accepts only the exact approved Following addition and modified bytes without changing original hashes', () => {
    const source = followingSource();
    const originalSource = source.client.source.bind(source.client);
    source.client.source = (commit, path) => {
      if (path === added) throw new Error('Absent producer file must never be fetched or fabricated');
      return originalSource(commit, path);
    };
    const proof = verifyReplayProducer(source.options, source.client);
    expect(proof.captureContractSha256).toBe(source.originalProof.captureContractSha256);
    expect(proof.runtimeDrift).toEqual({ ...source.drift, approvedSha256: source.options.approvedRuntimeDrift });
    expect(proof.runtimeDrift?.files.find((entry) => entry.path === added)?.producerSha256).toBeNull();
  });
  it.each(['missing', 'v1', 'false-presence', 'omitted-addition', 'later-bytes'])(
    'rejects %s approval of the new runtime helper',
    (kind) => {
      const source = followingSource();
      if (kind === 'missing') source.options.approvedRuntimeDrift = undefined;
      if (kind === 'v1') {
        const drift = {
          version: 1,
          producerSha,
          files: source.drift.files.map(({ path, producerSha256, currentSha256 }) => ({
            path,
            producerSha256,
            currentSha256,
          })),
        };
        source.options.approvedRuntimeDrift = replayHash(`${canonicalJson(drift)}\n`);
      }
      if (kind === 'false-presence') {
        source.drift.files.find((entry) => entry.path === added)!.producerPresent = true;
        source.options.approvedRuntimeDrift = replayHash(`${canonicalJson(source.drift)}\n`);
      }
      if (kind === 'omitted-addition') {
        source.drift.files = source.drift.files.filter((entry) => entry.path !== added);
        source.options.approvedRuntimeDrift = replayHash(`${canonicalJson(source.drift)}\n`);
      }
      if (kind === 'later-bytes') put(source.options.repoRoot, added, 'another version after approval');
      expect(() => verifyReplayProducer(source.options, source.client)).toThrow();
    },
  );
  it.each(['addition', 'deletion', 'rename', 'duplicate'])(
    'rejects unrelated capture path %s even alongside the approved addition',
    (kind) => {
      const source = followingSource();
      const original = source.client.files.bind(source.client);
      source.client.files = (commit) => {
        const paths = original(commit);
        if (commit === producerSha) return paths;
        if (kind === 'addition') return [...paths, 'scripts/lib/new-capture.ts'];
        if (kind === 'deletion') return paths.filter((path) => path !== following[0]);
        if (kind === 'rename') return paths.filter((path) => path !== added).concat(`${added}.renamed.ts`);
        return [...paths, added];
      };
      expect(() => verifyReplayProducer(source.options, source.client)).toThrow();
    },
  );
  it('cannot approve arbitrary edits when the new helper already existed at the producer', () => {
    const source = followingSource();
    source.client.files = () => trackedPaths;
    put(source.options.repoRoot, added, 'later implementation');
    const entry = source.drift.files.find((candidate) => candidate.path === added)!;
    entry.producerPresent = true;
    entry.producerSha256 = replayHash(readFileSync(join(ROOT, added)));
    entry.currentSha256 = replayHash(readFileSync(join(source.options.repoRoot, added)));
    source.options.approvedRuntimeDrift = replayHash(`${canonicalJson(source.drift)}\n`);
    expect(() => verifyReplayProducer(source.options, source.client)).toThrow();
  });
  // Frozen independently reviewed #6461 pairs; no historical Git objects are required in CI.
  const showcasePairs = [
    [
      'packages/mobile/.maestro/showcase/crew-join.yaml',
      '52026c245b2b3c1602717c9efdc4f4d96b9598cec0ee1ec99522f6286ba9166b',
      'ca84eb1ce1c718dd481e66e2287f3bea1b19a4664cb1092eb79d86db395da2de',
    ],
    [
      'packages/mobile/.maestro/showcase/crew-start.yaml',
      'bf19c0f3be2ca62e6b43e4fa21dc9812f257ff3a39105e9bed0f707c1b6c7099',
      'b06b3f22d9a21411e10b17f0bd65ae6e84418cdcfa65ed6271bb70aede62229e',
    ],
    [
      'packages/mobile/.maestro/showcase/crew.yaml',
      'cb6991dae991e07b322a7ab22495ac2e84ba48cf7554bf1dafb0d67e9837a7e8',
      '1039d08d7012495b4ccffa9cc0a497d0ea0027769f795e5f2c2e21b99cf1f642',
    ],
    [
      'packages/mobile/.maestro/showcase/session-end.yaml',
      'fdae995074170134130f5e9589220d0b3909d1999fd710d166719edb59723d57',
      '14273655c227272b244bebba2351a1a971be67b61755955e57a25baae3183ee9',
    ],
    [
      'scripts/lib/showcase-video/record.ts',
      'e214819230f6599076e8ff48385fd30f8c9bd5ccdb54bc9d6317e5a1d89839ce',
      'a4606ef3e7880016652edacc9f30a5e73bb918a2dc714701dc07f69bca5f2135',
    ],
    [
      'scripts/lib/showcase-video/render.ts',
      'c2be58c7761480c913fcad02ed1870a9a80295cfb41fc71217cd7093c07038c6',
      '3234e38e0af260dfd92dd2162acd3729d6297dae80f851689e6baf8bab9dc877',
    ],
  ] as const;
  it.each(showcasePairs)('accepts only the exact independently reviewed showcase pair: %s', (path, prior, current) => {
    expect(isReplayCapturePath(path)).toBe(true);
    expect(isReviewedShowcasePair(path, prior, current)).toBe(true);
    expect(isReviewedShowcasePair(path, prior, replayHash('future bytes'))).toBe(false);
    expect(isReviewedShowcasePair(path, replayHash('different producer'), current)).toBe(false);
    expect(isReviewedShowcasePair(`${path}.renamed`, prior, current)).toBe(false);
  });
  it.each(showcasePairs)(
    'rejects arbitrary bytes at showcase path %s despite an exact token for those bytes',
    (path) => {
      const source = followingSource();
      put(source.options.repoRoot, path, 'unreviewed future showcase implementation');
      source.drift.files.push({
        path,
        producerPresent: true,
        producerSha256: replayHash(readFileSync(join(ROOT, path))),
        currentPresent: true,
        currentSha256: replayHash(readFileSync(join(source.options.repoRoot, path))),
      });
      source.drift.files.sort((left, right) => (left.path < right.path ? -1 : 1));
      source.options.approvedRuntimeDrift = replayHash(`${canonicalJson(source.drift)}\n`);
      expect(() => verifyReplayProducer(source.options, source.client)).toThrow();
    },
  );
  it('keeps real CPP tooling ineligible even if a showcase hash pair is supplied', () => {
    const [_path, prior, current] = showcasePairs[0];
    expect(isReviewedShowcasePair('scripts/mobile-screenshots.ts', prior, current)).toBe(false);
    expect(isReviewedShowcasePair('packages/mobile/.maestro/app-store-cpp.yaml', prior, current)).toBe(false);
  });
});

describe('strict native replay retry history', () => {
  it.each([2, 3])('recovers carried executions and the one genuinely retried success from %s attempts', (attempts) => {
    const source = retrySource(attempts);
    const proof = verifyReplayProducer(source.options, source.client);
    expect(proof.attempt).toBe(attempts);
    expect(proof.artifacts).toHaveLength(16);
    expect(proof.artifacts[0].jobId).toBe(source.jobs[8].id);
    expect(proof.artifacts.at(-1)!.jobId).toBe(source.jobs.at(-1)!.id + (attempts - 1) * 100);
    expect(proof.retryHistory?.selectedExecutions).toHaveLength(18);
    expect(proof.retryHistory?.selectedExecutions.filter((entry) => entry.attempt === 1)).toHaveLength(17);
    expect(proof.retryHistory?.excludedArtifacts).toHaveLength(attempts - 1);
    expect(proof.retryHistory?.excludedArtifacts.map((entry) => entry.attempt)).toEqual(
      Array.from({ length: attempts - 1 }, (_, index) => index + 1),
    );
    expect(proof.retryHistory?.attempts).toHaveLength(attempts);
  });
  it.each([
    [
      'unbounded attempts',
      (source: ReturnType<typeof retrySource>) => {
        source.run.run_attempt = 11;
      },
    ],
    [
      'missing earlier inventory',
      (source: ReturnType<typeof retrySource>) => {
        source.histories.delete(1);
      },
    ],
    [
      'missing final native cell',
      (source: ReturnType<typeof retrySource>) => {
        source.histories.get(2)!.pop();
      },
    ],
    [
      'failed latest native job',
      (source: ReturnType<typeof retrySource>) => {
        source.histories.get(2)!.at(-1)!.conclusion = 'failure';
      },
    ],
    [
      'failed latest run',
      (source: ReturnType<typeof retrySource>) => {
        source.run.conclusion = 'failure';
      },
    ],
    [
      'wrong historical head',
      (source: ReturnType<typeof retrySource>) => {
        source.histories.get(1)![8].head_sha = 'e'.repeat(40);
      },
    ],
    [
      'wrong historical run',
      (source: ReturnType<typeof retrySource>) => {
        source.histories.get(1)![8].run_id = 999;
      },
    ],
    [
      'wrong historical attempt',
      (source: ReturnType<typeof retrySource>) => {
        source.histories.get(1)![8].run_attempt = 2;
      },
    ],
    [
      'duplicate job IDs',
      (source: ReturnType<typeof retrySource>) => {
        source.histories.get(2)![8].id = source.histories.get(1)![8].id;
      },
    ],
    [
      'unknown matrix name',
      (source: ReturnType<typeof retrySource>) => {
        source.histories.get(1)![8].name = 'cpp-capture (wrong)';
      },
    ],
    [
      'historical record execution',
      (source: ReturnType<typeof retrySource>) => {
        source.histories.get(1)![2].conclusion = 'success';
      },
    ],
    [
      'missing steps',
      (source: ReturnType<typeof retrySource>) => {
        source.histories.get(1)![8].steps = [];
      },
    ],
    [
      'changed carried step signature',
      (source: ReturnType<typeof retrySource>) => {
        (source.histories.get(2)![8].steps as Array<Record<string, unknown>>)[0].number = 2;
      },
    ],
    [
      'changed carried step timestamp within the same job window',
      (source: ReturnType<typeof retrySource>) => {
        (source.histories.get(2)![8].steps as Array<Record<string, unknown>>)[0].started_at = '2026-10-14T00:02:00Z';
      },
    ],
    [
      'step outside execution window',
      (source: ReturnType<typeof retrySource>) => {
        (source.histories.get(1)![8].steps as Array<Record<string, unknown>>)[0].completed_at = '2026-10-15T00:00:00Z';
      },
    ],
    [
      'partial artifact outside known failure',
      (source: ReturnType<typeof retrySource>) => {
        source.artifacts.at(-1)!.created_at = '2026-10-14T00:30:00Z';
      },
    ],
    [
      'unknown extra artifact',
      (source: ReturnType<typeof retrySource>) => {
        source.artifacts.push({ ...source.artifacts[0], id: 9000, name: 'ios-cpp-other' });
      },
    ],
    [
      'duplicate successful artifact',
      (source: ReturnType<typeof retrySource>) => {
        source.artifacts.push({ ...source.artifacts[0], id: 9000 });
      },
    ],
    [
      'duplicate artifact ID',
      (source: ReturnType<typeof retrySource>) => {
        source.artifacts.at(-1)!.id = source.artifacts[0].id;
      },
    ],
    [
      'expired failed artifact',
      (source: ReturnType<typeof retrySource>) => {
        source.artifacts.at(-1)!.expired = true;
      },
    ],
    [
      'mismatched failed artifact head',
      (source: ReturnType<typeof retrySource>) => {
        source.artifacts.at(-1)!.workflow_run = { id: runId, head_sha: 'e'.repeat(40) };
      },
    ],
    [
      'extra earlier successful artifact',
      (source: ReturnType<typeof retrySource>) => {
        const earlier = source.histories.get(1)!.at(-1)!;
        earlier.conclusion = 'success';
        (earlier.steps as Array<Record<string, unknown>>)[0].conclusion = 'success';
      },
    ],
    [
      'overlapping failed and successful windows',
      (source: ReturnType<typeof retrySource>) => {
        const earlier = source.histories.get(1)!.at(-1)!;
        const later = source.histories.get(2)!.at(-1)!;
        earlier.started_at = later.started_at;
        earlier.completed_at = later.completed_at;
        earlier.steps = structuredClone(later.steps);
        (earlier.steps as Array<Record<string, unknown>>)[0].conclusion = 'failure';
      },
    ],
  ] as const)('rejects %s instead of qualifying partial or ambiguous replay', (_name, mutate) => {
    const source = retrySource();
    mutate(source);
    expect(() => verifyReplayProducer(source.options, source.client)).toThrow();
  });
  it('binds excluded failure history and retained artifact identities to the reviewed receipt', () => {
    const source = retrySource();
    const proof = verifyReplayProducer(source.options, source.client);
    const expected = requireReviewedReceipt(proof, undefined, false);
    const failed = source.histories.get(1)!.at(-1)!;
    (failed.steps as Array<Record<string, unknown>>)[0].name = 'Changed failure evidence';
    const changed = verifyReplayProducer(source.options, source.client);
    expect(() => requireReviewedReceipt(changed, expected, true)).toThrow();
    source.artifacts.at(-1)!.digest = `sha256:${'e'.repeat(64)}`;
    expect(() => requireReviewedReceipt(verifyReplayProducer(source.options, source.client), expected, true)).toThrow();
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
  function preparedSource(source = sample()) {
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
    vi.spyOn(logbookCoverage, 'assertCppLogbookAttemptsReady').mockReturnValue(undefined);
    vi.spyOn(capture, 'readIosCampaignBoards').mockReturnValue([]);
    vi.spyOn(readiness, 'assertCppCaptureReady').mockImplementation(() => {});
    for (const artifact of source.artifacts) {
      const archive = archives.get(Number(artifact.id));
      if (archive) artifact.digest = `sha256:${replayHash(archive)}`;
    }
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
  it('assembles all sixteen successful retried shards without downloading excluded failed artifacts', async () => {
    const source = preparedSource(retrySource());
    const requested: number[] = [];
    const original = source.client.bytes.bind(source.client);
    source.client.bytes = (path) => {
      requested.push(Number(path.split('/').at(-2)));
      return original(path);
    };
    const digest = await prepareRetainedReplay(source.options, source.client);
    expect(requested).toEqual(validArtifacts.map((artifact) => artifact.id));
    const receipt = JSON.parse(readFileSync(source.options.receipt, 'utf8')) as {
      screenshots: number;
      retryHistory: { excludedArtifacts: unknown[] };
    };
    expect(receipt.screenshots).toBe(180);
    expect(receipt.retryHistory.excludedArtifacts).toHaveLength(1);
    const staged = preparedSource(retrySource());
    staged.options.stage = true;
    staged.options.expectedReceipt = digest;
    expect(await prepareRetainedReplay(staged.options, staged.client)).toBe(digest);
  });
  it('rechecks successful retry history after downloads and removes unreviewed assembled output', async () => {
    const retry = retrySource();
    const source = preparedSource(retry);
    const original = source.client.bytes.bind(source.client);
    source.client.bytes = (path) => {
      const failed = retry.histories.get(1)!.at(-1)!;
      (failed.steps as Array<Record<string, unknown>>)[0].name = 'Changed failed execution during download';
      return original(path);
    };
    await expect(prepareRetainedReplay(source.options, source.client)).rejects.toThrow();
    expect(existsSync(source.options.receipt)).toBe(false);
    expect(existsSync(join(source.options.repoRoot, 'app-stores/apple/cpp', target))).toBe(false);
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
  }, 20_000);
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
  it('requires current genuine MoonBoard Attempts coverage before accepting retained replay bytes', () => {
    const source = preparedSource();
    vi.mocked(logbookCoverage.assertCppLogbookAttemptsReady).mockRestore();
    expect(() => verifyReplayFixture(join(source.options.repoRoot, 'fixtures'), target)).toThrow('MoonBoard logbook');
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
