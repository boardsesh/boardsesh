import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getOperationAST, parse } from 'graphql';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GET_MY_BOARDS,
  SEARCH_CLIMBS,
  QUEUE_UPDATES_SUBSCRIPTION,
} from '../../packages/mobile/src/lib/graphql/operations';
import { JOIN_SESSION } from '../../packages/shared/graphql/src/operations/queue-session';
import { SEARCH_CLIMBS_COUNT } from '../../packages/shared/graphql/src/operations/climb-search';
import { bindCppGradeCountProof, cppGradeCountKey } from '../lib/cpp-grade-count';
import { mergeFixtureSets, graphqlFixtureContentHash } from '../screenshot-fixtures-merge';
import { CPP_MANIFEST_PATH, cppCaptureNames, readCppPage, type CppTarget } from '../lib/screenshot-cpp';
import { graphqlFixtureKey, type GraphqlFixtureFile, type ScreenshotFixtureManifest } from '../lib/screenshot-fixtures';
import { ACCEPTED_SIZES } from '../assert-screenshot-dimensions';
import {
  RETAINED_CPP_DEVICES,
  downloadRetainedCppRecord,
  verifyRetainedCppProducer,
  verifyRetainedCppNative,
  verifyRetainedCppSource,
  verifyRetainedCppMerged,
  type RetainedCppClient,
  type RetainedCppOptions,
} from '../prepare-retained-cpp-record';

const owner = '11111111-2222-3333-4444-555555555555';
const email = 'shots@example.test';
const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const directories: string[] = [];
const directory = () => {
  const root = mkdtempSync(join(tmpdir(), 'cpp-retained-test-'));
  directories.push(root);
  return root;
};
afterEach(() => {
  vi.restoreAllMocks();
  directories.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function sample(target: CppTarget = 'tension', emptySpray = false) {
  const page = readCppPage(target);
  const variants = [...page.heroBoards, ...page.otherBoards];
  const boards = variants.map((variant, index) => ({
    uuid: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name: `${variant.selector} owned`,
    ownerId: owner,
    canEdit: true,
    isPublic: false,
    boardType: variant.boardType,
    layoutId: variant.layoutId ?? index + 100,
    sizeId: variant.sizeId ?? 1,
    setIds: (variant.setIds ?? [1]).join(','),
    angle: variant.angle ?? 40,
  }));
  const coverage = {
    target,
    boardReadyText: Object.fromEntries(variants.map((variant, index) => [variant.id, `Scene ${index + 1}`])),
    boardIds: Object.fromEntries(variants.map((variant, index) => [variant.id, boards[index].uuid])),
    boardNames: Object.fromEntries(variants.map((variant, index) => [variant.id, boards[index].name])),
    boardHeroModes: Object.fromEntries(
      variants.map((variant) => [variant.id, emptySpray && variant.family === 'spray' ? 'wall-editor' : 'climb']),
    ) as Record<string, 'wall-editor' | 'climb'>,
    boardClimbCounts: Object.fromEntries(
      variants.map((variant) => [variant.id, emptySpray && variant.family === 'spray' ? 0 : 10]),
    ),
    heroClimbs: Object.fromEntries(
      variants
        .filter((variant) => !(emptySpray && variant.family === 'spray'))
        .map((variant) => {
          const index = variants.indexOf(variant);
          return [
            variant.id,
            {
              boardId: boards[index].uuid,
              climbId:
                index === 1 && target === 'tension'
                  ? '18E0834CBBB64952AE12BB7DD7F56E28'
                  : `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
              readyText: `Scene ${index + 1}`,
              gradeLabel: 'V3',
              statsAngle: boards[index].angle,
            },
          ];
        }),
    ),
    scenes: {},
    ...(!(emptySpray && page.primaryBoard.family === 'spray')
      ? {
          accessoryClimb: {
            boardId: boards[variants.findIndex((variant) => variant.id === page.primaryBoard.id)].uuid,
            climbId: '30000000-0000-4000-8000-000000000001',
            readyText: 'Accessory',
            gradeLabel: 'V2',
          },
        }
      : {}),
  };
  const manifest: ScreenshotFixtureManifest = {
    formatVersion: 1,
    flow: 'app-store-cpp',
    accountUserId: owner,
    accountEmail: email,
    upstream: 'http://127.0.0.1:1',
    recordedAt: '2026-10-12T00:00:00Z',
    frozenNow: '2026-10-12T00:00:01Z',
    graphql: [],
    static: [],
    capture: {
      sharedSessionId: '40000000-0000-4000-8000-000000000001',
      boards: boards.map((board) => board.name),
      cpp: coverage,
    },
  };
  const fixtures: GraphqlFixtureFile[] = [];
  const append = (query: string, variables: Record<string, unknown>, response: unknown) => {
    const operationName = getOperationAST(parse(query))!.name!.value;
    const key = graphqlFixtureKey({ operationName, query, variables }, sha256);
    const fixture: GraphqlFixtureFile = {
      formatVersion: 1,
      ...key,
      query,
      variables,
      response,
      status: 200,
      upstream: manifest.upstream,
      recordedAt: manifest.recordedAt,
    };
    manifest.graphql.push({ ...key, file: `graphql/${operationName}/${key.variablesHash.slice(0, 16)}.json` });
    fixtures.push(fixture);
    return fixture;
  };
  append(GET_MY_BOARDS, {}, { data: { myBoards: { boards } } });
  for (const board of boards) {
    const selected = [
      ...Object.values(coverage.heroClimbs),
      ...(coverage.accessoryClimb ? [coverage.accessoryClimb] : []),
    ].filter((climb) => climb.boardId === board.uuid);
    append(
      SEARCH_CLIMBS,
      {
        input: {
          boardName: board.boardType,
          layoutId: board.layoutId,
          sizeId: board.sizeId,
          setIds: board.setIds,
          angle: board.angle,
          page: 0,
          pageSize: 10,
        },
      },
      {
        data: {
          searchClimbs: {
            climbs: selected.map((climb) => ({
              uuid: climb.climbId,
              name: climb.readyText,
              frames: 'p1r12p2r13p3r14',
              statsAngle: board.angle,
              boardType: board.boardType,
              layoutId: board.layoutId,
              angle: board.angle,
            })),
          },
        },
      },
    );
  }
  if (target !== 'spray') {
    const board = boards[variants.findIndex((variant) => variant.id === page.primaryBoard.id)];
    const hero = coverage.heroClimbs[page.primaryBoard.id];
    const sessionId = manifest.capture!.sharedSessionId!;
    const boardPath = [board.boardType, board.layoutId, board.sizeId, board.setIds, board.angle].join('/');
    const item = {
      uuid: '50000000-0000-4000-8000-000000000001',
      climb: {
        uuid: hero.climbId,
        name: hero.readyText,
        boardType: board.boardType,
        layoutId: board.layoutId,
        angle: board.angle,
        frames: 'p1r12p2r13p3r14',
      },
    };
    const state = { queue: [item], currentClimbQueueItem: item };
    Object.assign(coverage.scenes, {
      search: { boardId: board.uuid, readyText: 'Filters' },
      queue: { boardId: board.uuid, sessionId, readyText: hero.readyText },
      status: { boardId: board.uuid, climbId: hero.climbId, readyText: hero.readyText },
      island: { boardId: board.uuid, readyText: hero.readyText },
    });
    append(
      JOIN_SESSION,
      { sessionId, boardPath, username: 'Liz', avatarUrl: null },
      {
        data: {
          joinSession: {
            id: sessionId,
            boardPath,
            isPublic: false,
            isLeader: true,
            users: [{ userId: owner, isLeader: true }],
            queueState: structuredClone(state),
          },
        },
      },
    );
    append(QUEUE_UPDATES_SUBSCRIPTION, { sessionId }, { data: { queueUpdates: { __typename: 'FullSync', state } } });
  }
  return { manifest, fixtures, boards, append };
}

const producerSha = 'a'.repeat(40),
  preparerSha = 'b'.repeat(40);
function metadata() {
  const root = directory();
  const options: RetainedCppOptions = {
    repository: 'boardsesh/boardsesh',
    runId: 123,
    target: 'tension',
    preparerSha,
    out: join(root, 'out'),
    receipt: join(root, 'receipt.json'),
  };
  const run = {
    id: 123,
    path: '.github/workflows/mobile-screenshots-ios.yml',
    repository: { full_name: options.repository },
    head_repository: { full_name: options.repository },
    workflow_id: 456,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'failure',
    run_attempt: 1,
    head_sha: producerSha,
  };
  const jobs = [
    { id: 1, name: 'setup' },
    { id: 2, name: 'cpp-bootstrap' },
    ...RETAINED_CPP_DEVICES.map(([name, slug], index) => ({
      id: index + 3,
      name: `cpp-capture (tension, en-US, ${name}, ${slug})`,
    })),
  ].map((job) => ({
    ...job,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-10-12T01:00:00Z',
    completed_at: '2026-10-12T01:10:00Z',
  }));
  jobs.push({ ...jobs[0], id: 7, name: 'cpp-prepare-record', conclusion: 'failure' });
  const artifacts = [
    { name: 'cpp-bootstrap-tension' },
    ...RETAINED_CPP_DEVICES.flatMap(([, slug]) => [
      { name: `screenshot-fixtures-cpp-capture-tension-en-US-${slug}` },
      { name: `ios-cpp-tension-cpp-capture-en-US-${slug}` },
    ]),
  ].map((artifact, index) => ({
    ...artifact,
    id: index + 10,
    expired: false,
    digest: `sha256:${'c'.repeat(64)}`,
    created_at: '2026-10-12T01:05:00Z',
    workflow_run: { id: 123, head_sha: producerSha },
  }));
  const archives = new Map<number, Buffer>();
  const calls: string[] = [];
  let ancestor = true;
  const client: RetainedCppClient = {
    json: (path) => {
      calls.push(path);
      return path.includes('/runs/') ? run : { id: 456, path: run.path };
    },
    pages: (path, field) => {
      calls.push(path);
      return field === 'jobs' ? jobs : artifacts;
    },
    bytes: (path) => {
      calls.push(path);
      if (path.endsWith('/logs'))
        return Buffer.from(
          'prepare-ios-campaign-fixtures.ts: CPP detail source lacks the genuine owned leader primary queue',
        );
      return archives.get(Number(path.split('/').at(-2)))!;
    },
    isAncestor: () => ancestor,
    workflow: () => readFileSync('.github/workflows/mobile-screenshots-ios.yml', 'utf8'),
  };
  return {
    root,
    options,
    run,
    jobs,
    artifacts,
    archives,
    client,
    calls,
    setAncestor: (allowed: boolean) => {
      ancestor = allowed;
    },
  };
}

describe('retained CPP producer authorization', () => {
  it('accepts only the old preparation failure after four genuine native successes', () => {
    const source = metadata();
    expect(verifyRetainedCppProducer(source.options, source.client)).toMatchObject({
      runId: 123,
      attempt: 1,
      producerSha,
      preparerSha,
    });
    expect(source.calls).toContain('repos/boardsesh/boardsesh/actions/runs/123/attempts/1/jobs?per_page=100');
  });
  it.each([
    [
      'foreign repository',
      (source: ReturnType<typeof metadata>) => {
        source.run.repository.full_name = 'foreign/repo';
      },
    ],
    [
      'fork source',
      (source: ReturnType<typeof metadata>) => {
        source.run.head_repository.full_name = 'foreign/repo';
      },
    ],
    [
      'wrong workflow',
      (source: ReturnType<typeof metadata>) => {
        source.run.workflow_id = 999;
      },
    ],
    [
      'different path',
      (source: ReturnType<typeof metadata>) => {
        source.run.path = 'evil.yml';
      },
    ],
    [
      'wrong event',
      (source: ReturnType<typeof metadata>) => {
        source.run.event = 'pull_request';
      },
    ],
    [
      'running producer',
      (source: ReturnType<typeof metadata>) => {
        source.run.status = 'in_progress';
      },
    ],
    [
      'cancelled producer',
      (source: ReturnType<typeof metadata>) => {
        source.run.conclusion = 'cancelled';
      },
    ],
    [
      'ambiguous second attempt',
      (source: ReturnType<typeof metadata>) => {
        source.run.run_attempt = 2;
      },
    ],
    [
      'invalid head',
      (source: ReturnType<typeof metadata>) => {
        source.run.head_sha = 'bad';
      },
    ],
    [
      'foreign history',
      (source: ReturnType<typeof metadata>) => {
        source.setAncestor(false);
      },
    ],
    [
      'failed native',
      (source: ReturnType<typeof metadata>) => {
        source.jobs[2].conclusion = 'failure';
      },
    ],
    [
      'missing native',
      (source: ReturnType<typeof metadata>) => {
        source.jobs.splice(2, 1);
      },
    ],
    [
      'duplicate native',
      (source: ReturnType<typeof metadata>) => {
        source.jobs.push({ ...source.jobs[2] });
      },
    ],
    [
      'wrong target',
      (source: ReturnType<typeof metadata>) => {
        source.jobs[2].name = source.jobs[2].name.replace('tension', 'kilter');
      },
    ],
    [
      'wrong attempt',
      (source: ReturnType<typeof metadata>) => {
        source.jobs[2].run_attempt = 2;
      },
    ],
    [
      'expired archive',
      (source: ReturnType<typeof metadata>) => {
        source.artifacts[1].expired = true;
      },
    ],
    [
      'duplicate archive',
      (source: ReturnType<typeof metadata>) => {
        source.artifacts.push({ ...source.artifacts[1] });
      },
    ],
    [
      'old attempt archive',
      (source: ReturnType<typeof metadata>) => {
        source.artifacts[1].created_at = '2026-10-11T01:05:00Z';
      },
    ],
    [
      'late archive',
      (source: ReturnType<typeof metadata>) => {
        source.artifacts[1].created_at = '2026-10-12T01:15:00Z';
      },
    ],
    [
      'foreign artifact run',
      (source: ReturnType<typeof metadata>) => {
        source.artifacts[1].workflow_run.id = 999;
      },
    ],
    [
      'foreign artifact source',
      (source: ReturnType<typeof metadata>) => {
        source.artifacts[1].workflow_run.head_sha = preparerSha;
      },
    ],
    [
      'missing digest',
      (source: ReturnType<typeof metadata>) => {
        source.artifacts[1].digest = '';
      },
    ],
  ])('rejects %s before archive reads or candidate output', async (_name, mutate) => {
    const source = metadata();
    mutate(source);
    await expect(downloadRetainedCppRecord(source.options, source.client)).rejects.toThrow(
      'failed source or artifact verification',
    );
    expect(source.calls.some((path) => path.endsWith('/zip'))).toBe(false);
    expect(existsSync(source.options.out)).toBe(false);
    expect(existsSync(source.options.receipt)).toBe(false);
  });
  it('rejects other preparation failures, unrelated job failures and an unpinned source workflow', () => {
    const source = metadata();
    source.client.bytes = () => Buffer.from('Authentication failed');
    expect(() => verifyRetainedCppProducer(source.options, source.client)).toThrow();
    source.run.conclusion = 'success';
    source.jobs[6].conclusion = 'success';
    source.jobs[0].conclusion = 'failure';
    expect(() => verifyRetainedCppProducer(source.options, source.client)).toThrow();
    source.jobs[0].conclusion = 'success';
    // Replace every source checkout to guarantee the actual capture checkout is unpinned.
    source.client.workflow = () =>
      readFileSync('.github/workflows/mobile-screenshots-ios.yml', 'utf8').replaceAll(
        'ref: ${{ needs.setup.outputs.source_sha }}',
        'ref: evil',
      );
    expect(() => verifyRetainedCppProducer(source.options, source.client)).toThrow();
  });
  it.each(['setup-output', 'compute-output', 'compute-env'])('rejects a changed producer %s source binding', (kind) => {
    const source = metadata();
    source.client.workflow = () => {
      const workflow = readFileSync('.github/workflows/mobile-screenshots-ios.yml', 'utf8');
      if (kind === 'setup-output')
        return workflow.replace('source_sha: ${{ steps.compute.outputs.source_sha }}', 'source_sha: unrelated');
      if (kind === 'compute-output') return workflow.replace('source_sha=$SOURCE_SHA', 'source_sha=unrelated');
      return workflow.replace(
        'id: compute\n        env:',
        'id: compute\n        env:\n          SOURCE_SHA: unrelated',
      );
    };
    expect(() => verifyRetainedCppProducer(source.options, source.client)).toThrow();
  });
});

function writeSource(root: string, source: ReturnType<typeof sample>) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(source.manifest));
  source.manifest.graphql.forEach((entry, index) => {
    const filename = join(root, entry.file);
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename, JSON.stringify(source.fixtures[index]));
  });
}
let seedRoot: string;
const pixels = new Map<string, Buffer>();
beforeAll(async () => {
  seedRoot = mkdtempSync(join(tmpdir(), 'cpp-retained-pixels-'));
  for (const [, device] of RETAINED_CPP_DEVICES) {
    const { width, height } = ACCEPTED_SIZES[device][0];
    const bytes = Buffer.alloc(width * height * 3, 20);
    let state = 123456789;
    for (let offset = 0; offset < width * 64 * 3; offset++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      bytes[offset] = state & 255;
    }
    pixels.set(
      device,
      await sharp(bytes, { raw: { width, height, channels: 3 } })
        .png()
        .toBuffer(),
    );
  }
});
afterAll(() => rmSync(seedRoot, { recursive: true, force: true }));
function writeNative(root: string, device: string, manifest: ScreenshotFixtureManifest) {
  const target = manifest.capture!.cpp!.target;
  const page = readCppPage(target);
  const png = pixels.get(device)!;
  const raw = join(root, 'raw-screenshots', 'en-US', device),
    framed = join(root, 'screenshots', 'en-US', device);
  mkdirSync(raw, { recursive: true });
  mkdirSync(framed, { recursive: true });
  for (const name of cppCaptureNames(page, device)) writeFileSync(join(raw, name), png);
  writeFileSync(
    join(raw, 'cpp-capture.json'),
    JSON.stringify({ target, verified: false, coverage: manifest.capture!.cpp }),
  );
  const presentation = {
    version: 1,
    locale: 'en-US',
    cpp: { target, manifestSha256: sha256(readFileSync(CPP_MANIFEST_PATH)) },
    files: {} as Record<string, unknown>,
  };
  for (const recipe of page.recipes[device.startsWith('ipad-') ? 'ipad' : 'phone']) {
    writeFileSync(join(framed, recipe.output), png);
    const source = { rawSha256: sha256(png), rawBytes: png.length };
    presentation.files[recipe.output] = {
      ...source,
      framedSha256: sha256(png),
      ...(recipe.sources.length > 1
        ? { sources: Object.fromEntries(recipe.sources.map((name) => [name, source])) }
        : {}),
    };
  }
  writeFileSync(join(framed, 'presentation.json'), JSON.stringify(presentation));
}
function zip(root: string): Buffer {
  const output = join(directory(), 'artifact.zip');
  execFileSync('python3', [
    '-c',
    'import pathlib,sys,zipfile\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED) as archive:\n for path in sorted(root.rglob("*")):\n  if path.is_file(): archive.write(path,path.relative_to(root))',
    root,
    output,
  ]);
  return readFileSync(output);
}
function withCount(source: ReturnType<typeof sample>, totalCount?: number, index = 0) {
  source.manifest.capture!.cpp!.scenes.search.gradeFilter = {
    minLabel: 'V1',
    maxLabel: 'V3',
    minGradeId: 13,
    maxGradeId: 16,
    expectedCount: 100,
  };
  if (totalCount !== undefined) {
    const key = cppGradeCountKey(source.manifest, source.fixtures);
    const fixture = source.append(SEARCH_CLIMBS_COUNT, key.variables, { data: { searchClimbs: { totalCount } } });
    fixture.recordedAt = `2026-10-12T00:00:00.${String(index).padStart(3, '0')}Z`;
    source.manifest = bindCppGradeCountProof(source.manifest, source.fixtures);
  }
  return source;
}
function recordingArtifacts(source: ReturnType<typeof metadata>, changingCounts = false) {
  const example = sample();
  for (const artifact of source.artifacts) {
    const root = join(source.root, String(artifact.id));
    mkdirSync(root);
    const device = artifact.name.split('en-US-')[1];
    const index = RETAINED_CPP_DEVICES.findIndex(([, slug]) => slug === device) + 1;
    const selected = changingCounts
      ? withCount(sample(), artifact.name.startsWith('cpp-bootstrap') ? undefined : 100 + index, index)
      : example;
    if (artifact.name.startsWith('cpp-bootstrap'))
      writeFileSync(join(root, 'cpp-scenario.json'), JSON.stringify(selected.manifest.capture));
    else if (artifact.name.startsWith('screenshot-fixtures')) writeSource(root, selected);
    else writeNative(root, device, selected.manifest);
    const archive = zip(root);
    source.archives.set(artifact.id, archive);
    artifact.digest = `sha256:${sha256(archive)}`;
  }
  return example;
}

describe('retained original source and native bytes', () => {
  it('accepts changing genuine counts across bootstrap, four shards and newest merge without rewriting originals', async () => {
    const source = metadata();
    recordingArtifacts(source, true);
    const originals = new Map(
      source.artifacts.map((artifact) => [artifact.id, source.archives.get(artifact.id)!.toString('base64')]),
    );
    await downloadRetainedCppRecord(source.options, source.client);
    const sets = RETAINED_CPP_DEVICES.map(([, device]) => {
      const label = join(source.options.out, device);
      const manifest = verifyRetainedCppSource(label, 'tension');
      const fixtures = manifest.graphql.map(
        (entry) => JSON.parse(readFileSync(join(label, entry.file), 'utf8')) as GraphqlFixtureFile,
      );
      return {
        label,
        manifest,
        contentHashes: new Map(
          manifest.graphql.map((entry, index) => [entry.file, graphqlFixtureContentHash(fixtures[index])]),
        ),
        graphqlRecordedAt: new Map(manifest.graphql.map((entry, index) => [entry.file, fixtures[index].recordedAt])),
        cppCountFixtures: fixtures,
      };
    });
    const merged = mergeFixtureSets(sets, { onConflict: 'newest' });
    expect(merged.manifest.capture!.cpp!.scenes.search.gradeFilter!.expectedCount).toBe(104);
    const mergedRoot = join(source.root, 'merged');
    mkdirSync(mergedRoot);
    writeFileSync(join(mergedRoot, 'manifest.json'), JSON.stringify(merged.manifest));
    for (const [filename, originalRoot] of merged.sources) {
      mkdirSync(dirname(join(mergedRoot, filename)), { recursive: true });
      writeFileSync(join(mergedRoot, filename), readFileSync(join(originalRoot, filename)));
    }
    expect(() => verifyRetainedCppMerged(mergedRoot, source.options.receipt)).not.toThrow();
    for (const artifact of source.artifacts)
      expect(source.archives.get(artifact.id)!.toString('base64')).toBe(originals.get(artifact.id));
    merged.manifest.capture!.cpp!.scenes.search.gradeFilter!.proof!.responseSha256 = '0'.repeat(64);
    writeFileSync(join(mergedRoot, 'manifest.json'), JSON.stringify(merged.manifest));
    expect(() => verifyRetainedCppMerged(mergedRoot, source.options.receipt)).toThrow();
  });
  it('verifies nine original artifacts without authentication and emits a receipt with separate sources and no private fields', async () => {
    const source = metadata();
    const example = recordingArtifacts(source);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    await downloadRetainedCppRecord(source.options, source.client);
    const receipt = readFileSync(source.options.receipt, 'utf8');
    expect(JSON.parse(receipt)).toMatchObject({ producerSha, preparerSha, target: 'tension' });
    for (const privateField of [
      owner,
      email,
      example.manifest.capture!.sharedSessionId!,
      'http://127.0.0.1',
      'accountUserId',
      'accountEmail',
    ])
      expect(receipt).not.toContain(privateField);
    for (const [, device] of RETAINED_CPP_DEVICES) {
      expect(readFileSync(join(source.options.out, device, 'manifest.json'))).toEqual(
        readFileSync(
          join(
            source.root,
            String(
              source.artifacts.find(
                (artifact) => artifact.name === `screenshot-fixtures-cpp-capture-tension-en-US-${device}`,
              )!.id,
            ),
            'manifest.json',
          ),
        ),
      );
    }
    const merged = join(source.root, 'merged');
    cpSync(join(source.options.out, 'iphone-16-pro-max'), merged, { recursive: true });
    expect(() => verifyRetainedCppMerged(merged, source.options.receipt)).not.toThrow();
    const joinFixture = example.fixtures.find((fixture) => fixture.operationName === 'JoinSession')!;
    const response = joinFixture.response as { data: { joinSession: { isLeader: boolean } } };
    response.data.joinSession.isLeader = false;
    writeSource(merged, example);
    expect(() => verifyRetainedCppMerged(merged, source.options.receipt)).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects ZIP digest tampering before extracting or emitting source output', async () => {
    const source = metadata();
    source.archives.set(10, Buffer.from('tampered ZIP'));
    await expect(downloadRetainedCppRecord(source.options, source.client)).rejects.toThrow();
    expect(existsSync(source.options.out)).toBe(false);
    expect(existsSync(source.options.receipt)).toBe(false);
  });
  it.each(['bootstrap-scenario', 'different-account', 'last-native'])(
    'rejects an original digest-matching %s mismatch before auth/output',
    async (kind) => {
      const source = metadata();
      const example = recordingArtifacts(source);
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
      const artifact = source.artifacts[kind === 'bootstrap-scenario' ? 0 : kind === 'different-account' ? 3 : 8];
      const root = join(source.root, String(artifact.id));
      if (kind === 'bootstrap-scenario')
        writeFileSync(
          join(root, 'cpp-scenario.json'),
          JSON.stringify({ ...example.manifest.capture, boards: ['Foreign scenario'] }),
        );
      if (kind === 'different-account') {
        example.manifest.accountEmail = 'foreign@example.test';
        writeSource(root, example);
      }
      if (kind === 'last-native')
        writeFileSync(join(root, 'raw-screenshots', 'en-US', 'ipad-pro-11-inch-m5', '04-led.png'), Buffer.alloc(0));
      const archive = zip(root);
      source.archives.set(artifact.id, archive);
      artifact.digest = `sha256:${sha256(archive)}`;
      await expect(downloadRetainedCppRecord(source.options, source.client)).rejects.toThrow(
        'failed source or artifact verification',
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(existsSync(source.options.out)).toBe(false);
      expect(existsSync(source.options.receipt)).toBe(false);
    },
  );
  it.each(['traversal', 'duplicate', 'symlink'])(
    'rejects a digest-matching %s archive without output',
    async (kind) => {
      const source = metadata();
      const filename = join(source.root, 'unsafe.zip');
      execFileSync(
        'python3',
        [
          '-c',
          'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as archive:\n if sys.argv[2]=="traversal": archive.writestr("../escape","blocked")\n elif sys.argv[2]=="duplicate":\n  archive.writestr("same","one"); archive.writestr("same","two")\n else:\n  entry=zipfile.ZipInfo("link");entry.create_system=3;entry.external_attr=0o120777<<16;archive.writestr(entry,"/tmp/escape")',
          filename,
          kind,
        ],
        { stdio: 'pipe' },
      );
      const archive = readFileSync(filename);
      source.archives.set(10, archive);
      source.artifacts[0].digest = `sha256:${sha256(archive)}`;
      await expect(downloadRetainedCppRecord(source.options, source.client)).rejects.toThrow(
        'failed source or artifact verification',
      );
      expect(existsSync(source.options.out)).toBe(false);
      expect(existsSync(source.options.receipt)).toBe(false);
    },
  );
  it.each(['owner', 'canonical', 'role', 'extra-file'])('rejects %s source evidence locally', (kind) => {
    const root = directory();
    const source = sample();
    if (kind === 'owner') source.boards[0].ownerId = 'foreign';
    if (kind === 'canonical') source.fixtures[0].documentHash = 'bad';
    if (kind === 'role')
      (
        source.fixtures.find((fixture) => fixture.operationName === 'JoinSession')!.response as {
          data: { joinSession: { isLeader: boolean } };
        }
      ).data.joinSession.isLeader = false;
    writeSource(root, source);
    if (kind === 'extra-file') writeFileSync(join(root, 'credentials.json'), 'synthetic-private');
    expect(() => verifyRetainedCppSource(root, 'tension')).toThrow();
  });
  it.each(['raw-bytes', 'unused-raw', 'framed-bytes', 'missing-native', 'foreign-device', 'scenario', 'manifest'])(
    'rejects %s native evidence',
    (kind) => {
      const source = sample();
      const root = directory();
      const device = 'iphone-16-pro-max';
      writeNative(root, device, source.manifest);
      const raw = join(root, 'raw-screenshots', 'en-US', device),
        framed = join(root, 'screenshots', 'en-US', device);
      if (kind === 'raw-bytes') writeFileSync(join(raw, 'hero-1.png'), Buffer.from('tampered'));
      if (kind === 'unused-raw') writeFileSync(join(raw, '04-led.png'), Buffer.alloc(0));
      if (kind === 'framed-bytes')
        writeFileSync(join(framed, readCppPage('tension').recipes.phone[0].output), Buffer.from('tampered'));
      if (kind === 'missing-native') rmSync(join(raw, 'hero-1.png'));
      if (kind === 'foreign-device') mkdirSync(join(root, 'raw-screenshots', 'es', 'unknown'), { recursive: true });
      if (kind === 'foreign-device')
        writeFileSync(join(root, 'raw-screenshots', 'es', 'unknown', 'evil.png'), pixels.get(device)!);
      if (kind === 'scenario')
        writeFileSync(
          join(raw, 'cpp-capture.json'),
          JSON.stringify({ target: 'kilter', verified: false, coverage: source.manifest.capture!.cpp }),
        );
      if (kind === 'manifest') {
        const filename = join(framed, 'presentation.json');
        const presentation = JSON.parse(readFileSync(filename, 'utf8')) as { cpp: { manifestSha256: string } };
        presentation.cpp.manifestSha256 = 'foreign';
        writeFileSync(filename, JSON.stringify(presentation));
      }
      expect(() => verifyRetainedCppNative(root, device, source.manifest)).toThrow();
    },
  );
});
