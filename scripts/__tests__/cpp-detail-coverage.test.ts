import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse, getOperationAST } from 'graphql';
import sharp from 'sharp';
import {
  GET_MY_BOARDS,
  SEARCH_CLIMBS,
  QUEUE_UPDATES_SUBSCRIPTION,
} from '../../packages/mobile/src/lib/graphql/operations';
import { JOIN_SESSION } from '../../packages/shared/graphql/src/operations/queue-session';
import { GET_USER_GROUPED_ASCENTS_FEED } from '../../packages/shared/graphql/src/operations/ticks';
import { assertCppLogbookAttemptsReady, resolveCppLogbookRead } from '../lib/cpp-logbook-coverage';
import {
  resolveCppBetaThumbnailRequests,
  resolveCppDetailReads,
  withCppDetailCoverage,
} from '../lib/cpp-detail-coverage';
import { readCppPage, type CppTarget } from '../lib/screenshot-cpp';
import { readScreenshotFixtureManifest } from '../lib/screenshot-backend';
import { prepareCppCampaignFixtures } from '../prepare-ios-campaign-fixtures';
import { mergeFixtureSets, graphqlFixtureContentHash } from '../screenshot-fixtures-merge';
import {
  graphqlFixtureKey,
  finalizeRecordingFrozenNow,
  pseudonymiseResponse,
  type GraphqlFixtureFile,
  type ScreenshotFixtureManifest,
} from '../lib/screenshot-fixtures';

const owner = '11111111-2222-3333-4444-555555555555';
const email = 'shots@example.test';
const password = 'test-password-do-not-log';
const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    ),
  );
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

const moonAscentId = 'a4aae9ee-67d3-4a4f-aa5b-a467966ea274';
function moonLogbookResponse(attempts = true) {
  const item = {
    uuid: moonAscentId,
    climbUuid: '62f43f16-9ac8-59d7-8803-794268fec151',
    climbName: 'MOON GIRL',
    boardType: 'moonboard',
    boardId: 1426893,
    boardDisplayName: 'MoonBoard 2024',
    layoutId: 3,
    renderBoard: { layoutId: 3, sizeId: 1, setIds: [5, 6, 7, 8, 9, 10] },
    angle: 40,
    isMirror: false,
    status: 'attempt',
    attemptCount: 1,
    difficulty: null,
    comment: 'Original genuine note',
    frames: 'p16r42p48r42p108r43',
    climbedAt: '2026-10-11 09:15:56.92',
  };
  const groups = [
    {
      key: `${item.climbUuid}-2026-10-11`,
      climbUuid: item.climbUuid,
      climbName: item.climbName,
      boardType: item.boardType,
      layoutId: item.layoutId,
      angle: item.angle,
      flashCount: 0,
      sendCount: 0,
      attemptCount: 1,
      items: [item],
    },
  ];
  if (!attempts)
    groups.push({
      ...groups[0],
      key: 'another-climb-2026-08-25',
      climbUuid: '597462c7-a684-5b65-a989-6b2f718d32c9',
      climbName: 'An easy problem',
      sendCount: 1,
      attemptCount: 0,
      items: [
        {
          ...item,
          uuid: 'e1981968-540b-4cfc-a355-b937666ec8f9',
          climbUuid: '597462c7-a684-5b65-a989-6b2f718d32c9',
          climbName: 'An easy problem',
          status: 'send',
          comment: 'Unrelated note',
        },
      ],
    });
  return { userGroupedAscentsFeed: { groups, totalCount: groups.length, hasMore: false } };
}

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
          pageSize: emptySpray && board.boardType === 'spray' ? 6 : 10,
          ...(emptySpray && board.boardType === 'spray'
            ? { sortBy: 'ascents', sortOrder: 'desc', boulders: true }
            : {}),
        },
      },
      {
        data: {
          searchClimbs: {
            ...(emptySpray && board.boardType === 'spray' ? { hasMore: false } : {}),
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
  if (target === 'moonboard') {
    Object.assign(coverage.scenes, {
      logbook: { boardId: coverage.boardIds[page.primaryBoard.id], readyText: 'MOON GIRL', ascentId: moonAscentId },
    });
    append(
      GET_USER_GROUPED_ASCENTS_FEED,
      {
        userId: owner,
        input: {
          boardType: 'moonboard',
          statusMode: 'both',
          flashOnly: false,
          sortBy: 'recent',
          sortOrder: 'desc',
          limit: 20,
          offset: 0,
        },
      },
      { data: moonLogbookResponse(false) },
    );
  }
  return { manifest, fixtures, boards, append };
}

function withSeparateStatusScene(useAccessory = false) {
  const source = sample('moonboard');
  const coverage = source.manifest.capture!.cpp!;
  const primary = readCppPage('moonboard').primaryBoard;
  const board = source.boards.find((candidate) => candidate.uuid === coverage.boardIds![primary.id])!;
  const status = {
    uuid: useAccessory ? coverage.accessoryClimb!.climbId : '60000000-0000-4000-8000-000000000001',
    name: useAccessory ? coverage.accessoryClimb!.readyText : 'MOON GIRL',
    boardType: board.boardType,
    layoutId: board.layoutId,
    angle: board.angle,
    frames: useAccessory ? 'p1r12p2r13p3r14' : 'p16r42p48r42p108r43',
    statsAngle: board.angle,
  };
  for (const fixture of source.fixtures) {
    const body = (fixture.response as { data: Record<string, unknown> }).data;
    if (
      fixture.operationName === 'SearchClimbs' &&
      (fixture.variables as { input: { layoutId: number } }).input.layoutId === board.layoutId
    ) {
      if (!useAccessory) (body.searchClimbs as { climbs: Record<string, unknown>[] }).climbs.push({ ...status });
    }
    if (fixture.operationName === 'JoinSession' || fixture.operationName === 'QueueUpdates') {
      const state = (
        fixture.operationName === 'JoinSession'
          ? (body.joinSession as { queueState: unknown }).queueState
          : (body.queueUpdates as { state: unknown }).state
      ) as { queue: { climb: Record<string, unknown> }[]; currentClimbQueueItem: { climb: Record<string, unknown> } };
      Object.assign(state.queue[0].climb, status);
      Object.assign(state.currentClimbQueueItem.climb, status);
    }
  }
  coverage.scenes.status.climbId = status.uuid;
  coverage.scenes.status.readyText = status.name;
  coverage.scenes.island.readyText = status.name;
  coverage.scenes.queue.readyText = status.name;
  return source;
}

function save(source: ReturnType<typeof sample>, upstream?: string) {
  if (upstream) {
    source.manifest.upstream = upstream;
    for (const fixture of source.fixtures) fixture.upstream = upstream;
  }
  const parent = mkdtempSync(join(tmpdir(), 'cpp-detail-test-'));
  directories.push(parent);
  const input = join(parent, 'input');
  mkdirSync(input);
  for (const [index, entry] of source.manifest.graphql.entries()) {
    mkdirSync(dirname(join(input, entry.file)), { recursive: true });
    writeFileSync(join(input, entry.file), JSON.stringify(source.fixtures[index]));
  }
  writeFileSync(join(input, 'manifest.json'), JSON.stringify(source.manifest));
  return { input, output: join(parent, 'candidate') };
}

function reply(operationName: string, variables: Record<string, unknown>): Record<string, unknown> {
  if (operationName === 'SearchClimbs') return { searchClimbs: { climbs: [], hasMore: false } };
  if (operationName === 'GetUserGroupedAscentsFeed') return moonLogbookResponse();
  if (operationName === 'GetBetaLinks')
    return {
      betaLinks: [
        {
          climbUuid: variables.climbUuid,
          link: 'https://example.test/video',
          foreignUsername: 'stranger_handle',
          angle: 40,
          thumbnail: null,
          isListed: true,
          createdAt: '2026-10-12T00:00:00Z',
          tickUuid: null,
          boardId: null,
        },
      ],
    };
  if (operationName === 'GetClimbProposals')
    return { climbProposals: { proposals: [], totalCount: 0, hasMore: false } };
  if (operationName === 'ClimbStatsHistory') return { climbStatsHistory: [] };
  return { profile: { id: owner, displayName: 'Liz', avatarUrl: null } };
}

function unavailableProposerReply(variables: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const input = variables.input as { boardType: string; climbUuid: string };
  const proposals: Record<string, unknown>[] = [
    {
      uuid: 'proposal-with-unavailable-profile',
      climbUuid: input.climbUuid,
      boardType: input.boardType,
      proposerId: null,
      proposerDisplayName: null,
      proposerAvatarUrl: null,
      ...overrides,
    },
  ];
  return {
    climbProposals: {
      proposals,
      totalCount: 1,
      hasMore: false,
    },
  };
}

async function upstream(
  options: {
    subject?: string;
    profileId?: string;
    hangOperation?: string;
    staticResponse?: (request: string) => { status?: number; body: Buffer; contentType: string };
    response?: (operationName: string, variables: Record<string, unknown>) => { status?: number; body: unknown };
  } = {},
) {
  const requests: Array<{ query: string; operationName: string; variables: Record<string, unknown> }> = [];
  const staticRequests: Array<{ path: string; authorization: string | undefined }> = [];
  let authRequests = 0;
  const token = `header.${Buffer.from(JSON.stringify({ sub: options.subject ?? owner })).toString('base64url')}.secret-native-jwt`;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url?.startsWith('/static/')) {
        staticRequests.push({ path: request.url, authorization: request.headers.authorization });
        const image = options.staticResponse?.(request.url);
        response.statusCode = image ? (image.status ?? 200) : 404;
        response.setHeader('content-type', image?.contentType ?? 'text/plain');
        response.end(image?.body ?? Buffer.from('not found'));
        return;
      }
      let raw = '';
      for await (const chunk of request) raw += String(chunk);
      response.setHeader('content-type', 'application/json');
      if (request.url === '/auth/native/credentials') {
        authRequests += 1;
        response.end(JSON.stringify({ jwt: token, refreshToken: 'never-persist-refresh-token' }));
        return;
      }
      const body = JSON.parse(raw) as { query: string; variables: Record<string, unknown> };
      const operationName = getOperationAST(parse(body.query))!.name!.value;
      requests.push({ ...body, operationName });
      if (options.hangOperation === operationName) return;
      const custom = options.response?.(operationName, body.variables);
      response.statusCode = custom?.status ?? 200;
      response.end(
        JSON.stringify(
          custom?.body ?? {
            data:
              operationName === 'CppBootstrapProfile'
                ? {
                    profile: { id: options.profileId ?? options.subject ?? owner, displayName: 'Liz', avatarUrl: null },
                  }
                : reply(operationName, body.variables),
          },
        ),
      );
    })();
  });
  servers.push(server);
  const port = await new Promise<number>((done) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      done(typeof address === 'object' && address ? address.port : 0);
    }),
  );
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    staticRequests,
    token,
    get authRequests() {
      return authRequests;
    },
  };
}

describe('CPP selected detail source evidence', () => {
  it('includes only the explicit distinct primary status scene within eight identities and24native reads', () => {
    const source = withSeparateStatusScene();
    const queue = source.fixtures.find((fixture) => fixture.operationName === 'QueueUpdates')!;
    const state = (queue.response as { data: { queueUpdates: { state: { queue: Record<string, unknown>[] } } } }).data
      .queueUpdates.state;
    const unrelatedId = '70000000-0000-4000-8000-000000000001';
    state.queue.push({
      uuid: '70000000-0000-4000-8000-000000000002',
      climb: { uuid: unrelatedId, boardType: 'moonboard', layoutId: 3, angle: 40, frames: 'p9r42' },
    });
    const reads = resolveCppDetailReads(source.manifest, source.fixtures);
    expect(reads).toHaveLength(24);
    expect(reads.some((request) => JSON.stringify(request.variables).includes(unrelatedId))).toBe(false);
    const currentReads = reads.filter((request) =>
      JSON.stringify(request.variables).includes('60000000-0000-4000-8000-000000000001'),
    );
    expect(currentReads.map((request) => request.operationName)).toEqual([
      'GetBetaLinks',
      'GetClimbProposals',
      'ClimbStatsHistory',
    ]);
  });
  it('deduplicates a status scene already selected as the primary accessory', () => {
    const source = withSeparateStatusScene(true);
    expect(resolveCppDetailReads(source.manifest, source.fixtures)).toHaveLength(21);
  });
  it.each(['kilter', 'tension', 'moonboard', 'spray'] as const)(
    'binds at most21 exact native reads to every %s hero plus accessory',
    (target) => {
      const source = sample(target);
      const reads = resolveCppDetailReads(source.manifest, source.fixtures);
      expect(reads).toHaveLength(21);
      expect(
        reads
          .filter((request) => request.operationName === 'GetClimbProposals')
          .every(
            (request) =>
              Object.keys(request.variables).join() === 'input' &&
              Object.keys(request.variables.input as object)
                .sort()
                .join() === 'boardType,climbUuid,limit',
          ),
      ).toBe(true);
      expect(new Set(reads.map((request) => request.variablesHash)).size).toBe(21);
    },
  );
  it('matches the exact observed Masquerade replay misses without changing UUIDcase', () => {
    const source = sample();
    const reads = resolveCppDetailReads(source.manifest, source.fixtures).filter((request) =>
      JSON.stringify(request.variables).includes('18E0834CBBB64952AE12BB7DD7F56E28'),
    );
    expect(reads.map((request) => request.variablesHash)).toEqual([
      '75dea9cfae7bd7b2dfb108c1ed12a8f84be07a866116d6917b432b0ef471e168',
      '6a03aa7fb538da695fef31ec6b62a5676439f1f5fd0a1780a5855bb449325473',
      'cf674193689d8a15e0955b9160ed62aadade5d4f2651f9aa99b5edacc68c37d9',
    ]);
  });
  it('records exact empty editor list reads while retaining other three genuine heroes', () => {
    const source = sample('spray', true);
    const reads = resolveCppDetailReads(source.manifest, source.fixtures);
    expect(reads.filter((request) => request.operationName !== 'SearchClimbs')).toHaveLength(9);
    const searches = reads.filter((request) => request.operationName === 'SearchClimbs');
    expect(searches).toHaveLength(3);
    expect(searches.map((request) => request.variables)).toEqual(
      source.boards
        .filter((board) => board.boardType === 'spray')
        .map((board) => ({
          input: {
            boardName: 'spray',
            layoutId: board.layoutId,
            sizeId: board.sizeId,
            setIds: board.setIds,
            angle: board.angle,
            page: 0,
            pageSize: 30,
            sortBy: 'ascents',
            sortOrder: 'desc',
            boulders: true,
            crossAngleStats: false,
          },
        })),
    );
    source.manifest.capture!.cpp!.boardClimbCounts!['spray-liz'] = 1;
    expect(() => resolveCppDetailReads(source.manifest, source.fixtures)).toThrow('explicitly empty');
  });
  it.each(['public', 'uneditable', 'missing-seed', 'nonempty-seed', 'more-pages'])(
    'rejects editor list completion from %s source evidence',
    (fault) => {
      const source = sample('spray', true);
      const board = source.boards.find((candidate) => candidate.boardType === 'spray')!;
      const seed = source.fixtures.find(
        (fixture) =>
          fixture.operationName === 'SearchClimbs' &&
          (fixture.variables as { input: { layoutId: number } }).input.layoutId === board.layoutId,
      )!;
      if (fault === 'public') board.isPublic = true;
      if (fault === 'uneditable') board.canEdit = false;
      if (fault === 'missing-seed') {
        const index = source.fixtures.indexOf(seed);
        source.fixtures.splice(index, 1);
        source.manifest.graphql.splice(index, 1);
      }
      const response = seed.response as { data: { searchClimbs: { climbs: unknown[]; hasMore: boolean } } };
      if (fault === 'nonempty-seed') response.data.searchClimbs.climbs.push({ uuid: 'unexpected' });
      if (fault === 'more-pages') response.data.searchClimbs.hasMore = true;
      expect(() => resolveCppDetailReads(source.manifest, source.fixtures)).toThrow();
    },
  );
  it('rejects an existing editor list that no longer matches the empty source', () => {
    const source = sample('spray', true);
    const request = resolveCppDetailReads(source.manifest, source.fixtures).find(
      (candidate) => candidate.operationName === 'SearchClimbs',
    )!;
    source.append(request.query, request.variables, {
      data: { searchClimbs: { climbs: [{ uuid: 'new' }], hasMore: false } },
    });
    expect(() => resolveCppDetailReads(source.manifest, source.fixtures)).toThrow('genuinely empty');
  });
  it('records real editor lists without replacing the distinct seed response bytes', async () => {
    const source = sample('spray', true);
    const service = await upstream();
    const { input } = save(source, service.origin);
    const originals = new Map(
      source.manifest.graphql.map((entry) => [entry.file, readFileSync(join(input, entry.file))]),
    );
    const logs: string[] = [];
    await withCppDetailCoverage(
      input,
      { upstream: service.origin, email, password: 'test', log: (line) => logs.push(line) },
      async (recording) => {
        const completed = readScreenshotFixtureManifest(recording)!;
        const searches = service.requests.filter((request) => request.operationName === 'SearchClimbs');
        expect(searches).toHaveLength(3);
        expect(searches.every((request) => (request.variables.input as { pageSize: number }).pageSize === 30)).toBe(
          true,
        );
        for (const [file, bytes] of originals) expect(readFileSync(join(recording, file))).toEqual(bytes);
        expect(completed.graphql.filter((entry) => entry.operationName === 'SearchClimbs')).toHaveLength(9);
      },
    );
    expect(logs.filter((line) => line.startsWith('CPP editor list evidence:'))).toHaveLength(3);
  });
  it.each(['nonempty', 'more-pages', 'errors', 'http-failure'])(
    'refuses an upstream editor list with %s without preparing a candidate',
    async (fault) => {
      const source = sample('spray', true);
      const service = await upstream({
        response: (operation, variables) => {
          if (operation !== 'SearchClimbs') return { body: { data: reply(operation, variables) } };
          return {
            status: fault === 'http-failure' ? 503 : 200,
            body:
              fault === 'errors'
                ? { errors: [{ message: 'failed' }] }
                : {
                    data: {
                      searchClimbs: {
                        climbs: fault === 'nonempty' ? [{ uuid: 'new' }] : [],
                        hasMore: fault === 'more-pages',
                      },
                    },
                  },
          };
        },
      });
      const { input } = save(source, service.origin);
      let prepared = false;
      await expect(
        withCppDetailCoverage(input, { upstream: service.origin, email, password: 'test' }, async () => {
          prepared = true;
        }),
      ).rejects.toThrow();
      expect(prepared).toBe(false);
    },
  );
  it.each([
    [
      'owner',
      (source: ReturnType<typeof sample>) => {
        source.boards[0].ownerId = 'another-owner';
      },
    ],
    [
      'geometry',
      (source: ReturnType<typeof sample>) => {
        source.boards[0].layoutId += 1;
      },
    ],
    [
      'climb',
      (source: ReturnType<typeof sample>) => {
        source.manifest.capture!.cpp!.heroClimbs!['tension-original'].climbId = 'ffffffff-0000-4000-8000-000000000001';
      },
    ],
    [
      'upstream',
      (source: ReturnType<typeof sample>) => {
        source.fixtures[0].upstream = 'https://foreign.example';
      },
    ],
    [
      'timestamp',
      (source: ReturnType<typeof sample>) => {
        source.fixtures[0].recordedAt = '2030-01-01T00:00:00Z';
      },
    ],
    [
      'status',
      (source: ReturnType<typeof sample>) => {
        source.fixtures[0].status = 500;
      },
    ],
    [
      'hash',
      (source: ReturnType<typeof sample>) => {
        source.fixtures[0].documentHash = '0'.repeat(64);
      },
    ],
    [
      'index',
      (source: ReturnType<typeof sample>) => {
        source.manifest.graphql[0].file = 'graphql/other.json';
      },
    ],
    [
      'duplicate',
      (source: ReturnType<typeof sample>) => {
        source.manifest.graphql.push(source.manifest.graphql[0]);
        source.fixtures.push(source.fixtures[0]);
      },
    ],
    [
      'board order',
      (source: ReturnType<typeof sample>) => {
        source.manifest.capture!.boards.reverse();
      },
    ],
    [
      'unknown hero',
      (source: ReturnType<typeof sample>) => {
        source.manifest.capture!.cpp!.heroClimbs!.foreign =
          source.manifest.capture!.cpp!.heroClimbs!['tension-original'];
      },
    ],
  ])('rejects tampered %s before authorizing reads', (_label, change) => {
    const source = sample();
    (change as (source: ReturnType<typeof sample>) => void)(source);
    expect(() => resolveCppDetailReads(source.manifest, source.fixtures)).toThrow();
  });
  it('rejects a different native document even when its canonical hash was recomputed', () => {
    const source = sample();
    source.fixtures[0].query = 'query GetMyBoards { myBoards { boards { uuid } } }';
    const key = graphqlFixtureKey(source.fixtures[0], sha256);
    Object.assign(source.fixtures[0], key);
    Object.assign(source.manifest.graphql[0], key);
    expect(() => resolveCppDetailReads(source.manifest, source.fixtures)).toThrow('native document');
  });
  it('rejects conflicting ownership in paginated roster evidence', () => {
    const source = sample();
    source.append(
      GET_MY_BOARDS,
      { offset: 6 },
      { data: { myBoards: { boards: [{ ...source.boards[0], ownerId: 'foreign' }] } } },
    );
    expect(() => resolveCppDetailReads(source.manifest, source.fixtures)).toThrow('unique recorded owner');
  });
});

describe('CPP genuine beta thumbnail completion', () => {
  const thumbnail = '/static/beta-link-thumbnails/instagram/C6-VpKiLFfN.jpg';
  const secondThumbnail = '/static/beta-link-thumbnails/tiktok/native_beta.jpg';
  const withThumbnails = (operationName: string, variables: Record<string, unknown>, thumbnails = [thumbnail]) => {
    const contents = reply(operationName, variables);
    if (operationName !== 'GetBetaLinks') return contents;
    const rows = (contents as { betaLinks: Record<string, unknown>[] }).betaLinks;
    return { betaLinks: thumbnails.map((source) => ({ ...rows[0], thumbnail: source })) };
  };
  const imageBytes = () =>
    sharp({ create: { width: 3, height: 2, channels: 3, background: '#234567' } })
      .png()
      .toBuffer();

  it('records every distinct referenced native request through the real proxy, retaining original bytes and clocks', async () => {
    const image = await imageBytes();
    const api = await upstream({
      response: (operationName, variables) => ({
        body: { data: withThumbnails(operationName, variables, [thumbnail, secondThumbnail, thumbnail]) },
      }),
      staticResponse: () => ({ body: image, contentType: 'image/png' }),
    });
    const source = sample();
    const { input, output } = save(source, api.origin);
    const sourceManifest = readFileSync(join(input, 'manifest.json'));
    const originalFiles = source.manifest.graphql.map((entry) => readFileSync(join(input, entry.file)));
    const logs: string[] = [];
    await prepareCppCampaignFixtures(input, output, {
      upstream: api.origin,
      email,
      password,
      log: (line) => logs.push(line),
    });
    const completed = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
    expect(api.staticRequests).toEqual([
      { path: `${thumbnail}?size=280`, authorization: undefined },
      { path: `${secondThumbnail}?size=280`, authorization: undefined },
    ]);
    expect(completed.static).toHaveLength(2);
    for (const entry of completed.static) {
      expect(entry.query).toBe('size=280');
      expect(entry.bytes).toBe(image.length);
      expect(readFileSync(join(output, entry.file))).toEqual(image);
    }
    expect(readFileSync(join(input, 'manifest.json'))).toEqual(sourceManifest);
    expect(source.manifest.graphql.map((entry) => readFileSync(join(output, entry.file)))).toEqual(originalFiles);
    const proofLines = logs.filter((line) => line.startsWith('CPP thumbnail evidence: '));
    expect(proofLines).toHaveLength(2);
    for (const line of proofLines) {
      const proof = JSON.parse(line.slice('CPP thumbnail evidence: '.length)) as {
        recordedAt: string;
        sha256: string;
        sourceFixtures: { file: string; sha256: string }[];
      };
      expect(proof.sha256).toBe(sha256(image));
      expect(Date.parse(completed.frozenNow)).toBeGreaterThanOrEqual(Date.parse(proof.recordedAt));
      for (const fixture of proof.sourceFixtures)
        expect(sha256(readFileSync(join(output, fixture.file)))).toBe(fixture.sha256);
    }
    expect(logs.join('\n')).not.toContain(password);
    expect(logs.join('\n')).not.toContain(api.token);
  });

  it('completes existing detail rows without refetching GraphQL, then resumes without replacing any bytes', async () => {
    const image = await imageBytes();
    const api = await upstream({ staticResponse: () => ({ body: image, contentType: 'image/png' }) });
    const source = sample();
    for (const request of resolveCppDetailReads(source.manifest, source.fixtures))
      source.append(
        request.query,
        request.variables,
        pseudonymiseResponse({ data: withThumbnails(request.operationName, request.variables) }, { ownUserId: owner })
          .response,
      );
    expect(resolveCppBetaThumbnailRequests(source.manifest, source.fixtures).size).toBe(1);
    const { input, output } = save(source, api.origin);
    await prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password });
    expect(api.requests.map((request) => request.operationName)).toEqual(['CppBootstrapProfile']);
    expect(api.staticRequests).toHaveLength(1);
    const prepared = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
    const preparedBytes = readFileSync(join(output, 'manifest.json'));
    const resumed = join(dirname(output), 'resumed');
    await prepareCppCampaignFixtures(output, resumed, { upstream: api.origin, email, password });
    expect(api.staticRequests).toHaveLength(1);
    expect(readFileSync(join(resumed, 'manifest.json'))).toEqual(preparedBytes);
    for (const entry of [...prepared.graphql, ...prepared.static])
      expect(readFileSync(join(resumed, entry.file))).toEqual(readFileSync(join(output, entry.file)));
  });

  it.each(['404', 'html', 'truncated', 'mime mismatch'])(
    'refuses %s source responses without creating a candidate or altering the input',
    async (failure) => {
      const image = await imageBytes();
      const api = await upstream({
        response: (operationName, variables) => ({ body: { data: withThumbnails(operationName, variables) } }),
        staticResponse: () => ({
          status: failure === '404' ? 404 : 200,
          body:
            failure === 'html'
              ? Buffer.from('<html>upstream-private-response</html>')
              : failure === 'truncated'
                ? image.subarray(0, 20)
                : image,
          contentType: failure === 'html' ? 'text/html' : failure === 'mime mismatch' ? 'image/jpeg' : 'image/png',
        }),
      });
      const source = sample();
      const { input, output } = save(source, api.origin);
      const before = readFileSync(join(input, 'manifest.json'));
      await expect(
        prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password }),
      ).rejects.toThrow('CPP beta thumbnail');
      expect(existsSync(output)).toBe(false);
      expect(readFileSync(join(input, 'manifest.json'))).toEqual(before);
    },
  );

  it('rejects unsupported thumbnail scope before credentials on a complete source', async () => {
    const api = await upstream();
    const source = sample();
    for (const request of resolveCppDetailReads(source.manifest, source.fixtures))
      source.append(
        request.query,
        request.variables,
        pseudonymiseResponse(
          { data: withThumbnails(request.operationName, request.variables, ['https://untrusted.invalid/image.jpg']) },
          { ownUserId: owner },
        ).response,
      );
    const { input, output } = save(source, api.origin);
    await expect(prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password })).rejects.toThrow(
      'cached native source',
    );
    expect(api.authRequests).toBe(0);
    expect(api.staticRequests).toHaveLength(0);
    expect(existsSync(output)).toBe(false);
  });
});

describe('CPP genuine detail recording and candidate preparation', () => {
  it.each([
    'status board',
    'status UUID',
    'status title',
    'island title',
    'current frames',
    'current angle',
    'join leader',
    'participant leader',
    'source upstream',
  ])('rejects a distinct current scene with tampered %s before authentication or candidate output', async (change) => {
    const api = await upstream();
    const source = withSeparateStatusScene();
    const coverage = source.manifest.capture!.cpp!;
    const joinedFixture = source.fixtures.find((fixture) => fixture.operationName === 'JoinSession')!;
    const joined = (
      joinedFixture.response as { data: { joinSession: { isLeader: boolean; users: { isLeader: boolean }[] } } }
    ).data.joinSession;
    const queuedFixture = source.fixtures.find((fixture) => fixture.operationName === 'QueueUpdates')!;
    const current = (
      queuedFixture.response as {
        data: { queueUpdates: { state: { currentClimbQueueItem: { climb: { frames: string; angle: number } } } } };
      }
    ).data.queueUpdates.state.currentClimbQueueItem.climb;
    if (change === 'status board') coverage.scenes.status.boardId = '70000000-0000-4000-8000-000000000001';
    if (change === 'status UUID') coverage.scenes.status.climbId = '70000000-0000-4000-8000-000000000001';
    if (change === 'status title') coverage.scenes.status.readyText = 'Unknown title';
    if (change === 'island title') coverage.scenes.island.readyText = 'Unknown title';
    if (change === 'current frames') current.frames = 'p9r42';
    if (change === 'current angle') current.angle = 35;
    if (change === 'join leader') joined.isLeader = false;
    if (change === 'participant leader') joined.users[0].isLeader = false;
    const { input, output } = save(source, api.origin);
    if (change === 'source upstream') {
      joinedFixture.upstream = 'https://foreign.example';
      const entry = source.manifest.graphql.find((candidate) => candidate.operationName === 'JoinSession')!;
      writeFileSync(join(input, entry.file), JSON.stringify(joinedFixture));
    }
    const before = source.manifest.graphql.map((entry) => readFileSync(join(input, entry.file)));
    await expect(prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password })).rejects.toThrow(
      'CPP detail',
    );
    expect(api.authRequests).toBe(0);
    expect(api.requests).toHaveLength(0);
    expect(existsSync(output)).toBe(false);
    expect(source.manifest.graphql.map((entry) => readFileSync(join(input, entry.file)))).toEqual(before);
  });
  it('records24genuine reads for a distinct status/current scene without repairing original hero or fixture bytes', async () => {
    const api = await upstream();
    const source = withSeparateStatusScene();
    const { input, output } = save(source, api.origin);
    const before = source.manifest.graphql.map((entry) => readFileSync(join(input, entry.file)));
    await prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password });
    expect(
      api.requests.filter(
        (request) => !['CppBootstrapProfile', 'GetUserGroupedAscentsFeed'].includes(request.operationName),
      ),
    ).toHaveLength(24);
    expect(source.manifest.graphql.map((entry) => readFileSync(join(output, entry.file)))).toEqual(before);
    expect(source.manifest.graphql.map((entry) => readFileSync(join(input, entry.file)))).toEqual(before);
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
    expect(manifest.capture).toEqual(source.manifest.capture);
  });
  it('rejects the newest negative JoinSession kept by the real merge before authentication and candidate output', async () => {
    const api = await upstream();
    const older = sample('kilter');
    const newest = sample('kilter');
    const negative = newest.fixtures.find((fixture) => fixture.operationName === 'JoinSession')!;
    const joined = (
      negative.response as { data: { joinSession: { isLeader: boolean; users: { isLeader: boolean }[] } } }
    ).data.joinSession;
    joined.isLeader = false;
    joined.users[0].isLeader = false;
    negative.recordedAt = '2026-10-12T00:00:02Z';
    newest.manifest.frozenNow = '2026-10-12T00:00:03Z';
    const sources = [older, newest];
    const before = sources.map((source) => JSON.stringify(source.fixtures));
    const merged = mergeFixtureSets(
      sources.map((source, index) => ({
        label: String(index),
        manifest: source.manifest,
        contentHashes: new Map(
          source.manifest.graphql.map((entry, fixtureIndex) => [
            entry.file,
            graphqlFixtureContentHash(source.fixtures[fixtureIndex]),
          ]),
        ),
        graphqlRecordedAt: new Map(
          source.manifest.graphql.map((entry, fixtureIndex) => [entry.file, source.fixtures[fixtureIndex].recordedAt]),
        ),
      })),
      { onConflict: 'newest' },
    );
    const mergedSource = {
      ...newest,
      manifest: merged.manifest,
      fixtures: merged.manifest.graphql.map((entry) => {
        const source = sources[Number(merged.sources.get(entry.file))];
        return source.fixtures[source.manifest.graphql.findIndex((candidate) => candidate.file === entry.file)];
      }),
    };
    const retained = mergedSource.fixtures.find((fixture) => fixture.operationName === 'JoinSession')!;
    expect(retained).toBe(negative);
    expect(merged.conflicts.find((conflict) => conflict.key.startsWith('JoinSession'))).toMatchObject({
      took: '1',
      over: '0',
      tookRecordedAt: negative.recordedAt,
    });
    const { input, output } = save(
      {
        ...mergedSource,
        manifest: structuredClone(mergedSource.manifest),
        fixtures: structuredClone(mergedSource.fixtures),
      },
      api.origin,
    );
    const manifestBefore = readFileSync(join(input, 'manifest.json'));
    await expect(prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password })).rejects.toThrow(
      'owned leader',
    );
    expect(api.authRequests).toBe(0);
    expect(api.requests).toHaveLength(0);
    expect(existsSync(output)).toBe(false);
    expect(readFileSync(join(input, 'manifest.json'))).toEqual(manifestBefore);
    expect(joined.isLeader).toBe(false);
    expect(joined.users[0].isLeader).toBe(false);
    expect(sources.map((source) => JSON.stringify(source.fixtures))).toEqual(before);
  });
  it('prepares an explicitly empty spray editor without introducing a native JoinSession requirement', async () => {
    const api = await upstream();
    const source = sample('spray', true);
    expect(source.fixtures.some((fixture) => fixture.operationName === 'JoinSession')).toBe(false);
    const { input, output } = save(source, api.origin);
    // Keep the existing private-photo transformation; this test isolates its verified input.
    await withCppDetailCoverage(input, { upstream: api.origin, email, password }, async (recording) => {
      const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
      expect(manifest.graphql.filter((entry) => entry.operationName === 'GetBetaLinks')).toHaveLength(3);
      expect(manifest.graphql.some((entry) => entry.operationName === 'JoinSession')).toBe(false);
      expect(manifest.capture).toEqual(source.manifest.capture);
      expect(existsSync(output)).toBe(false);
    });
    expect(api.authRequests).toBe(1);
    expect(api.requests.filter((request) => request.operationName === 'SearchClimbs')).toHaveLength(3);
    expect(
      api.requests.filter((request) => !['CppBootstrapProfile', 'SearchClimbs'].includes(request.operationName)),
    ).toHaveLength(9);
  });
  it.each(['join false', 'participant false', 'missing JoinSession', 'missing QueueUpdates', 'complete resume false'])(
    'rejects manufacturer leader source %s before any authentication or detail query',
    async (reason) => {
      const api = await upstream();
      const source = sample('moonboard');
      if (reason === 'complete resume false')
        for (const request of resolveCppDetailReads(source.manifest, source.fixtures))
          source.append(
            request.query,
            request.variables,
            pseudonymiseResponse({ data: reply(request.operationName, request.variables) }, { ownUserId: owner })
              .response,
          );
      const joinedFixture = source.fixtures.find((fixture) => fixture.operationName === 'JoinSession')!;
      const joined = (
        joinedFixture.response as { data: { joinSession: { isLeader: boolean; users: { isLeader: boolean }[] } } }
      ).data.joinSession;
      if (reason === 'participant false') joined.users[0].isLeader = false;
      else if (reason.startsWith('missing ')) {
        const operation = reason.slice('missing '.length);
        source.fixtures = source.fixtures.filter((fixture) => fixture.operationName !== operation);
        source.manifest.graphql = source.manifest.graphql.filter((entry) => entry.operationName !== operation);
      } else joined.isLeader = false;
      const { input, output } = save(source, api.origin);
      const before = readFileSync(join(input, 'manifest.json'));
      await expect(
        prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password }),
      ).rejects.toThrow('owned leader');
      expect(api.authRequests).toBe(0);
      expect(api.requests).toHaveLength(0);
      expect(existsSync(output)).toBe(false);
      expect(readFileSync(join(input, 'manifest.json'))).toEqual(before);
    },
  );
  it.each(['manifest', 'fixture', 'ambient scenario'])(
    'refuses malformed %s with a bounded error before authentication',
    async (kind) => {
      const api = await upstream();
      const source = sample();
      const { input, output } = save(source, api.origin);
      const invalidContents = 'historical-sensitive-parse-secret';
      if (kind === 'ambient scenario') vi.stubEnv('BOARDSESH_SCREENSHOT_CAPTURE_SCENARIO', invalidContents);
      else
        writeFileSync(
          join(input, kind === 'manifest' ? 'manifest.json' : source.manifest.graphql[0].file),
          invalidContents,
        );
      const failure: unknown = await prepareCppCampaignFixtures(input, output, {
        upstream: api.origin,
        email,
        password,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/^CPP detail/);
      expect((failure as Error).message).not.toContain(invalidContents);
      expect(api.authRequests).toBe(0);
      expect(api.requests).toHaveLength(0);
      expect(existsSync(output)).toBe(false);
    },
  );
  it.each(['jwt', 'refreshToken', 'access_token', 'password', 'auth_token'])(
    'rejects an existing response credential field %s before authentication without rewriting source',
    async (credentialKey) => {
      const api = await upstream();
      const source = sample();
      (source.fixtures[0].response as { data: Record<string, unknown> }).data.review = [
        { [credentialKey]: 'historical-source-secret' },
      ];
      const { input, output } = save(source, api.origin);
      const fixturePath = join(input, source.manifest.graphql[0].file);
      const before = readFileSync(fixturePath);
      const logs: string[] = [];
      await expect(
        prepareCppCampaignFixtures(input, output, {
          upstream: api.origin,
          email,
          password,
          log: (line) => logs.push(line),
        }),
      ).rejects.toThrow('provenance');
      expect(api.authRequests).toBe(0);
      expect(api.requests).toHaveLength(0);
      expect(existsSync(output)).toBe(false);
      expect(readFileSync(fixturePath)).toEqual(before);
      expect(logs.join('\n')).not.toContain('historical-source-secret');
    },
  );
  it('accepts response metadata counters without treating them as credentials', () => {
    const source = sample();
    (source.fixtures[0].response as { data: Record<string, unknown> }).data.review = {
      tokenCount: 5,
      credentialsExpiry: '2030-01-01T00:00:00Z',
    };
    expect(resolveCppDetailReads(source.manifest, source.fixtures)).toHaveLength(21);
  });
  it('rejects an accessory on the explicitly empty primary spray editor before authentication', async () => {
    const api = await upstream();
    const source = sample('spray', true);
    const primaryId = readCppPage('spray').primaryBoard.id;
    source.manifest.capture!.cpp!.accessoryClimb = {
      boardId: source.manifest.capture!.cpp!.boardIds![primaryId],
      climbId: '30000000-0000-4000-8000-000000000001',
      readyText: 'Contradictory accessory',
      gradeLabel: 'V2',
    };
    const { input, output } = save(source, api.origin);
    await expect(prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password })).rejects.toThrow(
      'explicitly empty',
    );
    expect(api.authRequests).toBe(0);
    expect(api.requests).toHaveLength(0);
    expect(existsSync(output)).toBe(false);
  });
  it('records all21real reads through the proxy and keeps source/static/metadata immutable', async () => {
    const api = await upstream();
    const source = sample();
    const { input, output } = save(source, api.origin);
    mkdirSync(join(input, 'static'));
    writeFileSync(join(input, 'static/photo.bin'), 'actual-static-bytes');
    source.manifest.static.push({
      path: '/static/photo',
      query: '',
      file: 'static/photo.bin',
      contentType: 'application/octet-stream',
      bytes: 19,
    });
    writeFileSync(join(input, 'manifest.json'), JSON.stringify(source.manifest));
    const before = sha256(readFileSync(join(input, 'manifest.json')));
    const logs: string[] = [];
    await prepareCppCampaignFixtures(input, output, {
      upstream: api.origin,
      email,
      password,
      log: (line) => logs.push(line),
    });
    const result = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
    expect(result.accountUserId).toBe(owner);
    expect(result.accountEmail).toBe(email);
    expect(result.capture).toEqual(source.manifest.capture);
    expect(result.flow).toBe(source.manifest.flow);
    expect(result.static).toEqual(source.manifest.static);
    expect(sha256(readFileSync(join(input, 'manifest.json')))).toBe(before);
    expect(readFileSync(join(output, 'static/photo.bin'), 'utf8')).toBe('actual-static-bytes');
    for (const entry of source.manifest.graphql)
      expect(readFileSync(join(output, entry.file))).toEqual(readFileSync(join(input, entry.file)));
    expect(api.requests.filter((request) => request.operationName !== 'CppBootstrapProfile')).toHaveLength(21);
    expect(api.requests.every((request) => getOperationAST(parse(request.query))!.operation === 'query')).toBe(true);
    const created = result.graphql
      .filter((entry) => !source.manifest.graphql.some((previous) => previous.file === entry.file))
      .map((entry) => JSON.parse(readFileSync(join(output, entry.file), 'utf8')) as GraphqlFixtureFile);
    expect(result.frozenNow).toBe(
      finalizeRecordingFrozenNow(
        source.manifest.frozenNow,
        created.map((fixture) => fixture.recordedAt),
      ),
    );
    expect(created.find((fixture) => fixture.operationName === 'GetBetaLinks')!.response).toMatchObject({
      data: { betaLinks: [{ foreignUsername: expect.stringMatching(/^climber_/) }] },
    });
    expect(JSON.stringify(created)).not.toContain(api.token);
    expect(JSON.stringify(created)).not.toContain('never-persist-refresh-token');
    expect(logs.join('\n')).not.toContain(password);
    expect(logs.join('\n')).not.toContain(api.token);
    expect(logs.join('\n')).not.toContain('stranger_handle');
  });
  it('authenticates a complete resumed recording while skipping all existing detail reads and preserving its clock', async () => {
    const api = await upstream();
    const source = sample();
    for (const request of resolveCppDetailReads(source.manifest, source.fixtures))
      source.append(
        request.query,
        request.variables,
        pseudonymiseResponse({ data: reply(request.operationName, request.variables) }, { ownUserId: owner }).response,
      );
    const { input, output } = save(source, api.origin);
    await prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password });
    expect(api.requests.map((request) => request.operationName)).toEqual(['CppBootstrapProfile']);
    expect(readFileSync(join(output, 'manifest.json'))).toEqual(readFileSync(join(input, 'manifest.json')));
  });
  it.each(['wrong token owner', 'wrong fresh profile'])(
    'blocks %s with no detail requests or candidate',
    async (reason) => {
      const api = await upstream(
        reason === 'wrong token owner' ? { subject: 'different-owner' } : { profileId: 'different-owner' },
      );
      const source = sample();
      const { input, output } = save(source, api.origin);
      await expect(
        prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password }),
      ).rejects.toThrow('authentication');
      expect(api.requests.filter((request) => request.operationName !== 'CppBootstrapProfile')).toHaveLength(0);
      expect(existsSync(output)).toBe(false);
    },
  );
  it.each([
    'HTTP error',
    'GraphQL error',
    'missing data',
    'malformed beta',
    'malformed proposals',
    'malformed history',
    'live credential',
    'untracked credential field',
  ])('blocks %s and keeps output absent', async (reason) => {
    const api = await upstream({
      response: (operationName, variables) => {
        if (operationName === 'CppBootstrapProfile') return { body: { data: reply(operationName, variables) } };
        if (reason === 'HTTP error') return { status: 503, body: { data: {} } };
        if (reason === 'GraphQL error')
          return {
            body: {
              data: reply(operationName, variables),
              errors: [{ message: 'sensitive upstream text do not log' }],
            },
          };
        if (reason === 'missing data') return { body: {} };
        if (reason === 'untracked credential field')
          return { body: { data: { ...reply(operationName, variables), jwt: 'historical-source-secret' } } };
        if (reason === 'malformed beta' && operationName === 'GetBetaLinks')
          return { body: { data: { betaLinks: null } } };
        if (reason === 'malformed proposals' && operationName === 'GetClimbProposals')
          return { body: { data: { climbProposals: { proposals: [], totalCount: -1, hasMore: 'yes' } } } };
        if (reason === 'malformed history' && operationName === 'ClimbStatsHistory')
          return { body: { data: { climbStatsHistory: {} } } };
        if (reason === 'live credential')
          return {
            body: {
              data: {
                betaLinks: [
                  {
                    link: `header.${Buffer.from(JSON.stringify({ sub: owner })).toString('base64url')}.secret-native-jwt`,
                  },
                ],
              },
            },
          };
        return { body: { data: reply(operationName, variables) } };
      },
    });
    const source = sample();
    const { input, output } = save(source, api.origin);
    const before = readFileSync(join(input, 'manifest.json'));
    const logs: string[] = [];
    await expect(
      prepareCppCampaignFixtures(input, output, {
        upstream: api.origin,
        email,
        password,
        log: (line) => logs.push(line),
      }),
    ).rejects.toThrow('CPP detail');
    expect(existsSync(output)).toBe(false);
    expect(readFileSync(join(input, 'manifest.json'))).toEqual(before);
    expect(logs.join('\n')).not.toContain('sensitive upstream text');
  });
  it('rejects an invalid existing detail collision before any authentication request', async () => {
    const api = await upstream();
    const source = sample();
    const expected = resolveCppDetailReads(source.manifest, source.fixtures)[0];
    source.append(expected.query, expected.variables, { data: { betaLinks: null } });
    const { input, output } = save(source, api.origin);
    await expect(prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password })).rejects.toThrow(
      'native collection',
    );
    expect(api.requests).toHaveLength(0);
    expect(existsSync(output)).toBe(false);
  });
  it('rejects an existing detail document collision even when the source hashes are internally consistent', async () => {
    const api = await upstream();
    const source = sample();
    const expected = resolveCppDetailReads(source.manifest, source.fixtures)[0];
    source.append(
      'query GetBetaLinks($boardType: String!, $climbUuid: String!) { betaLinks(boardType: $boardType, climbUuid: $climbUuid) { link } }',
      expected.variables,
      { data: { betaLinks: [] } },
    );
    const { input, output } = save(source, api.origin);
    await expect(prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password })).rejects.toThrow(
      'collides',
    );
    expect(api.requests).toHaveLength(0);
    expect(existsSync(output)).toBe(false);
  });
  it('refuses an unsanitized existing proposer response without rewriting it or authenticating', async () => {
    const api = await upstream();
    const source = sample();
    const expected = resolveCppDetailReads(source.manifest, source.fixtures).find(
      (request) => request.operationName === 'GetClimbProposals',
    )!;
    source.append(expected.query, expected.variables, {
      data: {
        climbProposals: {
          proposals: [
            {
              proposerId: '55555555-6666-4777-8888-999999999999',
              proposerDisplayName: 'Private proposer',
              proposerAvatarUrl: 'https://cdn/private-proposer.jpg',
            },
          ],
          totalCount: 1,
          hasMore: false,
        },
      },
    });
    const { input, output } = save(source, api.origin);
    const before = readFileSync(join(input, 'manifest.json'));
    await expect(prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password })).rejects.toThrow(
      'provenance',
    );
    expect(api.requests).toHaveLength(0);
    expect(existsSync(output)).toBe(false);
    expect(readFileSync(join(input, 'manifest.json'))).toEqual(before);
  });
  it('rejects malformed items inside a present native collection', async () => {
    const api = await upstream({
      response: (operationName, variables) => ({
        body: {
          data: operationName === 'GetBetaLinks' ? { betaLinks: ['malformed-row'] } : reply(operationName, variables),
        },
      }),
    });
    const { input, output } = save(sample(), api.origin);
    await expect(prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password })).rejects.toThrow(
      'native collection',
    );
    expect(existsSync(output)).toBe(false);
  });
  it('does not accept another selected climb UUID in a genuine response collection', async () => {
    const api = await upstream({
      response: (operationName, variables) => ({
        body: {
          data:
            operationName === 'GetBetaLinks'
              ? reply(operationName, { climbUuid: 'foreign-climb' })
              : reply(operationName, variables),
        },
      }),
    });
    const { input, output } = save(sample(), api.origin);
    await expect(prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password })).rejects.toThrow(
      'native collection',
    );
    expect(existsSync(output)).toBe(false);
  });
  it('only fetches missing exact responses on a partial resume and preserves the valid existing entry bytes', async () => {
    const api = await upstream();
    const source = sample();
    const expected = resolveCppDetailReads(source.manifest, source.fixtures)[0];
    const already = source.append(expected.query, expected.variables, { data: { betaLinks: [] } });
    const { input, output } = save(source, api.origin);
    const file = source.manifest.graphql.find(
      (entry) => entry.operationName === already.operationName && entry.variablesHash === already.variablesHash,
    )!.file;
    await prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password });
    expect(api.requests.filter((request) => request.operationName !== 'CppBootstrapProfile')).toHaveLength(20);
    expect(readFileSync(join(output, file))).toEqual(readFileSync(join(input, file)));
  });
  it('fails closed when the authenticated detail request times out and returns without awaiting the stuck response', async () => {
    const api = await upstream({ hangOperation: 'GetBetaLinks' });
    const { input, output } = save(sample(), api.origin);
    const networkFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((request, init) => {
      const address = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
      // Shorten only the transport's existing deadline on its loopback request.
      if (
        address !== `${api.origin}/graphql` &&
        address.endsWith('/graphql') &&
        typeof init?.body === 'string' &&
        init.body.includes('query GetBetaLinks')
      )
        return networkFetch(request, { ...init, signal: AbortSignal.timeout(30) });
      return networkFetch(request, init);
    });
    await expect(prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password })).rejects.toThrow(
      'GetBetaLinks read failed',
    );
    expect(existsSync(output)).toBe(false);
    expect(api.requests.filter((request) => request.operationName === 'GetBetaLinks')).toHaveLength(1);
  });
  it('pseudonymizes genuine nonempty proposal responses before candidate bytes are emitted', async () => {
    const stranger = '55555555-6666-4777-8888-999999999999';
    const api = await upstream({
      response: (operationName, variables) => {
        if (operationName !== 'GetClimbProposals') return { body: { data: reply(operationName, variables) } };
        const input = variables.input as { boardType: string; climbUuid: string };
        return {
          body: {
            data: {
              climbProposals: {
                proposals: [
                  {
                    uuid: 'real-proposal',
                    climbUuid: input.climbUuid,
                    boardType: input.boardType,
                    proposerId: stranger,
                    proposerDisplayName: 'Private proposer',
                    proposerAvatarUrl: 'https://cdn/private-proposer.jpg',
                  },
                ],
                totalCount: 1,
                hasMore: false,
              },
            },
          },
        };
      },
    });
    const { input, output } = save(sample(), api.origin);
    await prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password });
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
    for (const entry of manifest.graphql.filter((entry) => entry.operationName === 'GetClimbProposals')) {
      const serialized = readFileSync(join(output, entry.file), 'utf8');
      expect(serialized).not.toContain('Private proposer');
      expect(serialized).not.toContain('private-proposer.jpg');
      expect(JSON.parse(serialized).response.data.climbProposals.proposals[0]).toMatchObject({
        proposerId: stranger,
        proposerAvatarUrl: null,
      });
    }
  });
  it('records an unavailable proposer as null while still masking an identified foreign proposer', async () => {
    const api = await upstream({
      response: (operationName, variables) => {
        if (operationName !== 'GetClimbProposals') return { body: { data: reply(operationName, variables) } };
        const response = unavailableProposerReply(variables);
        response.climbProposals.proposals.push({
          ...response.climbProposals.proposals[0],
          uuid: 'proposal-with-available-foreign-profile',
          proposerId: '55555555-6666-4777-8888-999999999999',
          proposerDisplayName: 'Private proposer',
          proposerAvatarUrl: 'https://cdn/private-proposer.jpg',
        });
        response.climbProposals.totalCount = 2;
        return { body: { data: response } };
      },
    });
    const source = sample();
    const { input, output } = save(source, api.origin);
    const before = source.manifest.graphql.map((entry) => readFileSync(join(input, entry.file)));
    const logs: string[] = [];
    await prepareCppCampaignFixtures(input, output, {
      upstream: api.origin,
      email,
      password,
      log: (line) => logs.push(line),
    });
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
    const entries = manifest.graphql.filter((entry) => entry.operationName === 'GetClimbProposals');
    expect(entries).toHaveLength(7);
    for (const entry of entries) {
      const serialized = readFileSync(join(output, entry.file), 'utf8');
      const fixture = JSON.parse(serialized) as GraphqlFixtureFile;
      const expected = unavailableProposerReply(fixture.variables as Record<string, unknown>).climbProposals
        .proposals[0];
      const rows = (fixture.response as { data: { climbProposals: { proposals: Record<string, unknown>[] } } }).data
        .climbProposals.proposals;
      expect(rows[0]).toEqual(expected);
      expect(rows[1]).toMatchObject({
        proposerId: '55555555-6666-4777-8888-999999999999',
        proposerAvatarUrl: null,
      });
      expect(serialized).not.toContain('Private proposer');
      expect(serialized).not.toContain('private-proposer.jpg');
    }
    expect(source.manifest.graphql.map((entry) => readFileSync(join(input, entry.file)))).toEqual(before);
    expect(logs.join('\n')).not.toContain('Private proposer');
  });
  it('preserves every existing null-proposer response byte on a complete authenticated resume', async () => {
    const api = await upstream();
    const source = sample();
    for (const request of resolveCppDetailReads(source.manifest, source.fixtures))
      source.append(request.query, request.variables, {
        data:
          request.operationName === 'GetClimbProposals'
            ? unavailableProposerReply(request.variables)
            : pseudonymiseResponse(reply(request.operationName, request.variables), { ownUserId: owner }).response,
      });
    const { input, output } = save(source, api.origin);
    const before = source.manifest.graphql.map((entry) => readFileSync(join(input, entry.file)));
    await prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password });
    expect(api.authRequests).toBe(1);
    expect(api.requests.map((request) => request.operationName)).toEqual(['CppBootstrapProfile']);
    expect(readFileSync(join(output, 'manifest.json'))).toEqual(readFileSync(join(input, 'manifest.json')));
    expect(source.manifest.graphql.map((entry) => readFileSync(join(output, entry.file)))).toEqual(before);
    expect(source.manifest.graphql.map((entry) => readFileSync(join(input, entry.file)))).toEqual(before);
  });
  it.each([
    { proposerId: 42 },
    { proposerId: true },
    { proposerId: {} },
    { proposerId: [] },
    { proposerId: '' },
    { proposerDisplayName: 'Orphaned private name' },
    { proposerAvatarUrl: 'https://cdn/orphaned-private-avatar.jpg' },
  ])('rejects malformed or orphaned proposer metadata %j before authentication', async (overrides) => {
    const api = await upstream();
    const source = sample();
    const request = resolveCppDetailReads(source.manifest, source.fixtures).find(
      (candidate) => candidate.operationName === 'GetClimbProposals',
    )!;
    source.append(request.query, request.variables, { data: unavailableProposerReply(request.variables, overrides) });
    const { input, output } = save(source, api.origin);
    const before = source.manifest.graphql.map((entry) => readFileSync(join(input, entry.file)));
    await expect(prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password })).rejects.toThrow(
      'native collection',
    );
    expect(api.authRequests).toBe(0);
    expect(api.requests).toHaveLength(0);
    expect(existsSync(output)).toBe(false);
    expect(source.manifest.graphql.map((entry) => readFileSync(join(input, entry.file)))).toEqual(before);
  });
  it.each(['foreign upstream', 'wrong email', 'ambient scenario', 'source symlink', 'static size'])(
    'rejects %s before any network request',
    async (reason) => {
      const api = await upstream();
      const source = sample();
      const { input, output } = save(source, api.origin);
      if (reason === 'ambient scenario')
        vi.stubEnv('BOARDSESH_SCREENSHOT_CAPTURE_SCENARIO', JSON.stringify({ different: true }));
      if (reason === 'source symlink') symlinkSync(join(input, 'manifest.json'), join(input, 'linked.json'));
      if (reason === 'static size') {
        mkdirSync(join(input, 'static'));
        writeFileSync(join(input, 'static/asset.bin'), 'a');
        source.manifest.static.push({
          file: 'static/asset.bin',
          path: '/asset',
          query: '',
          contentType: 'image/png',
          bytes: 2,
        });
        writeFileSync(join(input, 'manifest.json'), JSON.stringify(source.manifest));
      }
      await expect(
        prepareCppCampaignFixtures(input, output, {
          upstream: reason === 'foreign upstream' ? 'https://foreign.example' : api.origin,
          email: reason === 'wrong email' ? 'other@example.test' : email,
          password,
        }),
      ).rejects.toThrow('CPP detail');
      expect(api.requests).toHaveLength(0);
      expect(existsSync(output)).toBe(false);
    },
  );
  it('leaves an existing output untouched and makes no request', async () => {
    const api = await upstream();
    const { input, output } = save(sample(), api.origin);
    mkdirSync(output);
    writeFileSync(join(output, 'keep'), 'preserve');
    await expect(prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password })).rejects.toThrow(
      'already exists',
    );
    expect(readFileSync(join(output, 'keep'), 'utf8')).toBe('preserve');
    expect(api.requests).toHaveLength(0);
  });
  it('hands prepared coverage to the existing callback and removes only its owned scratch copy', async () => {
    const api = await upstream();
    const { input } = save(sample('spray', true), api.origin);
    let scratch = '';
    const observed = await withCppDetailCoverage(
      input,
      { upstream: api.origin, email, password },
      async (recording) => {
        scratch = recording;
        return JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
      },
    );
    expect(
      observed.graphql.filter((entry) =>
        ['GetBetaLinks', 'GetClimbProposals', 'ClimbStatsHistory'].includes(entry.operationName),
      ),
    ).toHaveLength(9);
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(input)).toBe(true);
  });
});

describe('MoonBoard exact native Attempts preparation', () => {
  it('records one genuine filtered page, preserves every original byte and leaves the selected scene untouched', async () => {
    const api = await upstream();
    const source = sample('moonboard');
    const { input, output } = save(source, api.origin);
    const before = new Map(
      ['manifest.json', ...source.manifest.graphql.map((entry) => entry.file)].map((file) => [
        file,
        readFileSync(join(input, file)),
      ]),
    );
    await prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password });
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
    const fixtures = manifest.graphql.map(
      (entry) => JSON.parse(readFileSync(join(output, entry.file), 'utf8')) as GraphqlFixtureFile,
    );
    expect(assertCppLogbookAttemptsReady(manifest, fixtures)).toMatchObject({
      target: 'moonboard',
      ascentId: moonAscentId,
    });
    expect(manifest.capture).toEqual(source.manifest.capture);
    for (const [file, bytes] of before) {
      expect(readFileSync(join(input, file))).toEqual(bytes);
      if (file !== 'manifest.json') expect(readFileSync(join(output, file))).toEqual(bytes);
    }
    const reads = api.requests.filter((entry) => entry.operationName === 'GetUserGroupedAscentsFeed');
    expect(reads).toHaveLength(1);
    expect(reads[0].variables).toEqual({
      userId: owner,
      input: {
        boardType: 'moonboard',
        statusMode: 'attempt',
        flashOnly: false,
        sortBy: 'recent',
        sortOrder: 'desc',
        limit: 20,
        offset: 0,
      },
    });
    expect(api.requests.filter((entry) => entry.operationName !== 'CppBootstrapProfile')).toHaveLength(22);
    expect(getOperationAST(parse(reads[0].query))!.operation).toBe('query');
    const filtered = fixtures.find(
      (entry) => entry.variablesHash === resolveCppLogbookRead(manifest, fixtures)!.variablesHash,
    )!;
    expect(filtered.response).toEqual({ data: moonLogbookResponse() });
  });

  it.each([
    'missing primary',
    'changed primary',
    'send primary',
    'foreign board',
    'duplicate primary',
    'changed group winner',
    'split group winner',
    'credential',
    'wrong page shape',
  ])('rejects %s from the real recording proxy without changing source or producing a candidate', async (reason) => {
    const api = await upstream({
      response: (operationName, variables) => {
        if (operationName !== 'GetUserGroupedAscentsFeed') return { body: { data: reply(operationName, variables) } };
        const response = moonLogbookResponse();
        const feed = response.userGroupedAscentsFeed;
        const item = feed.groups[0].items[0];
        if (reason === 'missing primary') item.uuid = 'ffffffff-1111-4444-8888-111111111111';
        if (reason === 'changed primary') item.comment = 'Edited live note';
        if (reason === 'send primary') item.status = 'send';
        if (reason === 'foreign board') item.boardType = 'kilter';
        if (reason === 'duplicate primary') feed.groups[0].items.push({ ...item });
        if (reason === 'changed group winner') {
          feed.groups[0].items.push({
            ...item,
            uuid: 'ffffffff-1111-4444-8888-111111111111',
            climbedAt: '2026-10-11 10:00:00.00',
          });
          feed.groups[0].attemptCount = 2;
        }
        if (reason === 'split group winner') {
          feed.groups.push({
            ...feed.groups[0],
            key: 'split-server-group',
            items: [{ ...item, uuid: 'ffffffff-1111-4444-8888-111111111111', climbedAt: '2026-10-11 10:00:00.00' }],
          });
          feed.totalCount = 2;
        }
        if (reason === 'credential') Object.assign(item, { accessToken: 'must-never-be-logged' });
        if (reason === 'wrong page shape') feed.totalCount = -1;
        return { body: { data: response } };
      },
    });
    const source = sample('moonboard');
    const { input, output } = save(source, api.origin);
    const before = readFileSync(join(input, 'manifest.json'));
    const logs: string[] = [];
    await expect(
      prepareCppCampaignFixtures(input, output, {
        upstream: api.origin,
        email,
        password,
        log: (line) => logs.push(line),
      }),
    ).rejects.toThrow();
    expect(existsSync(output)).toBe(false);
    expect(readFileSync(join(input, 'manifest.json'))).toEqual(before);
    expect(logs.join('\n')).not.toContain('must-never-be-logged');
  });

  it('resumes a complete prepared page with a fresh owner check and identical bytes/clock', async () => {
    const api = await upstream();
    const source = sample('moonboard');
    for (const request of [
      ...resolveCppDetailReads(source.manifest, source.fixtures),
      resolveCppLogbookRead(source.manifest, source.fixtures)!,
    ])
      source.append(
        request.query,
        request.variables,
        pseudonymiseResponse({ data: reply(request.operationName, request.variables) }, { ownUserId: owner }).response,
      );
    const { input, output } = save(source, api.origin);
    await prepareCppCampaignFixtures(input, output, { upstream: api.origin, email, password });
    expect(api.requests.map((entry) => entry.operationName)).toEqual(['CppBootstrapProfile']);
    for (const file of ['manifest.json', ...source.manifest.graphql.map((entry) => entry.file)])
      expect(readFileSync(join(output, file))).toEqual(readFileSync(join(input, file)));
  });

  it.each([
    'wrong owner',
    'wrong board',
    'send source',
    'missing ascent',
    'query collision',
    'wrong upstream',
    'duplicate manifest entry',
    'missing filtered',
    'filtered credential',
  ])('fails closed on %s before native replay', (reason) => {
    const source = sample('moonboard');
    const request = resolveCppLogbookRead(source.manifest, source.fixtures)!;
    const filtered =
      reason === 'missing filtered'
        ? undefined
        : source.append(request.query, request.variables, { data: moonLogbookResponse() });
    if (filtered)
      expect(assertCppLogbookAttemptsReady(source.manifest, source.fixtures)).toMatchObject({ ascentId: moonAscentId });
    const original = source.fixtures.find((entry) => entry.operationName === 'GetUserGroupedAscentsFeed')!;
    const body = original.response as { data: ReturnType<typeof moonLogbookResponse> };
    if (reason === 'wrong owner') (original.variables as { userId: string }).userId = 'different-owner';
    if (reason === 'wrong board') body.data.userGroupedAscentsFeed.groups[0].items[0].boardType = 'tension';
    if (reason === 'send source') body.data.userGroupedAscentsFeed.groups[0].items[0].status = 'send';
    if (reason === 'missing ascent')
      body.data.userGroupedAscentsFeed.groups[0].items[0].uuid = 'ffffffff-1111-4444-8888-111111111111';
    if (reason === 'query collision') original.query = original.query.replace('totalCount', 'aliased: totalCount');
    if (reason === 'wrong upstream') filtered!.upstream = 'https://different.example.test';
    if (reason === 'duplicate manifest entry') source.manifest.graphql.push({ ...source.manifest.graphql.at(-1)! });
    if (reason === 'filtered credential') Object.assign(filtered!.response as object, { jwt: 'never-log-this' });
    expect(() => assertCppLogbookAttemptsReady(source.manifest, source.fixtures)).toThrow('MoonBoard logbook');
  });

  it('rejects a newer UTC-day winner even when preparation runs across Sydney midnight', () => {
    const source = sample('moonboard');
    const expected = resolveCppLogbookRead(source.manifest, source.fixtures)!;
    const response = moonLogbookResponse();
    const feed = response.userGroupedAscentsFeed;
    feed.groups.push({
      ...feed.groups[0],
      key: 'split-group',
      items: [
        {
          ...feed.groups[0].items[0],
          uuid: 'ffffffff-1111-4444-8888-111111111111',
          climbedAt: '2026-10-11 13:30:00.00',
        },
      ],
    });
    feed.totalCount = 2;
    source.append(expected.query, expected.variables, { data: response });
    const { input } = save(source);
    const code = `const fs = require('node:fs'); const { assertCppLogbookAttemptsReady } = require('./scripts/lib/cpp-logbook-coverage.ts'); const root = ${JSON.stringify(input)}; const manifest = JSON.parse(fs.readFileSync(root + '/manifest.json')); const fixtures = manifest.graphql.map(entry => JSON.parse(fs.readFileSync(root + '/' + entry.file))); try { assertCppLogbookAttemptsReady(manifest, fixtures); process.stdout.write('accepted'); } catch { process.stdout.write('rejected'); }`;
    for (const timezone of ['Australia/Sydney', 'UTC'])
      expect(
        execFileSync(process.execPath, ['--import', 'tsx', '-e', code], {
          cwd: process.cwd(),
          env: { ...process.env, TZ: timezone },
          encoding: 'utf8',
        }),
      ).toBe('rejected');
  });

  it.each(['angle', 'mirror', 'day'])('keeps a genuine separate %s bucket from replacing the primary', (difference) => {
    const source = sample('moonboard');
    const expected = resolveCppLogbookRead(source.manifest, source.fixtures)!;
    const response = moonLogbookResponse();
    const feed = response.userGroupedAscentsFeed;
    const other = {
      ...feed.groups[0].items[0],
      uuid: 'ffffffff-1111-4444-8888-111111111111',
      climbedAt: '2026-10-11 10:00:00.00',
    };
    if (difference === 'angle') other.angle = 50;
    if (difference === 'mirror') other.isMirror = true;
    if (difference === 'day') other.climbedAt = '2026-10-09 10:00:00.00';
    feed.groups.push({ ...feed.groups[0], key: 'another-native-bucket', items: [other] });
    feed.totalCount = 2;
    source.append(expected.query, expected.variables, { data: response });
    expect(assertCppLogbookAttemptsReady(source.manifest, source.fixtures)).toMatchObject({ ascentId: moonAscentId });
  });

  it('keeps unrelated targets and the source detail-only contract unchanged', () => {
    for (const target of ['kilter', 'tension', 'spray'] as const) {
      const source = sample(target);
      expect(resolveCppLogbookRead(source.manifest, source.fixtures)).toBeUndefined();
      expect(assertCppLogbookAttemptsReady(source.manifest, source.fixtures)).toBeUndefined();
      expect(resolveCppDetailReads(source.manifest, source.fixtures)).toHaveLength(21);
    }
    const moon = sample('moonboard');
    expect(resolveCppDetailReads(moon.manifest, moon.fixtures)).toHaveLength(21);
    expect(() => assertCppLogbookAttemptsReady(moon.manifest, moon.fixtures)).toThrow();
  });
});
