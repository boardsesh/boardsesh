import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CONFIRM_CLIMB_ON_WALL, JOIN_SESSION } from '../../packages/shared/graphql/src/operations/queue-session';
import {
  GET_MY_BOARDS,
  SEARCH_CLIMBS,
  QUEUE_UPDATES_SUBSCRIPTION,
} from '../../packages/mobile/src/lib/graphql/operations';
import { createScreenshotBackend, type ScreenshotBackendServer } from '../lib/screenshot-backend';
import { readCppPage } from '../lib/screenshot-cpp';
import { isCppWallConfirmation } from '../lib/screenshot-campaign-session';
import { graphqlFixtureKey, type GraphqlFixtureFile, type ScreenshotFixtureManifest } from '../lib/screenshot-fixtures';

const accountId = '11111111-2222-4333-8444-555555555555';
const boardId = '22222222-3333-4444-8555-666666666666';
const sessionId = '33333333-4444-4555-8666-777777777777';
const climbId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const queueItemId = '44444444-5555-4666-8777-888888888888';
const recordedAt = '2026-10-13T00:00:00Z';
const disabledResponse = {
  errors: [{ message: 'Physical wall confirmation is disabled in local screenshot replay' }],
};
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function sample(target: 'kilter' | 'tension' | 'moonboard' = 'kilter') {
  const primary = readCppPage(target).primaryBoard;
  const board = {
    uuid: boardId,
    ownerId: accountId,
    isPublic: false,
    isOwned: false,
    canEdit: true,
    boardType: primary.boardType,
    layoutId: primary.layoutId!,
    sizeId: primary.sizeId!,
    setIds: primary.setIds!.join(','),
    angle: primary.angle!,
  };
  const climb = {
    uuid: climbId,
    name: 'Recorded climb',
    boardType: board.boardType,
    layoutId: board.layoutId,
    angle: board.angle,
    frames: 'p1r1p2r2',
  };
  const queuedItem = { uuid: queueItemId, climb: { ...climb } };
  const joinedItem = { uuid: queueItemId, climb: { ...climb } };
  const queueState = { queue: [queuedItem], currentClimbQueueItem: queuedItem };
  const joinState = { queue: [joinedItem], currentClimbQueueItem: joinedItem };
  const boardPath = [board.boardType, board.layoutId, board.sizeId, board.setIds, board.angle].join('/');
  const joinResponse = {
    data: {
      joinSession: {
        id: sessionId,
        boardPath,
        isPublic: false,
        isLeader: true,
        users: [{ userId: accountId, isLeader: true }],
        queueState: joinState,
      },
    },
  };
  const queueResponse = { data: { queueUpdates: { __typename: 'FullSync', state: queueState } } };
  const rosterResponse = { data: { myBoards: { boards: [board] } } };
  const searchResponse = { data: { searchClimbs: { climbs: [{ ...climb }] } } };
  const manifest: ScreenshotFixtureManifest = {
    formatVersion: 1,
    flow: 'app-store-cpp',
    recordedAt,
    frozenNow: recordedAt,
    accountEmail: 'recorder@example.test',
    accountUserId: accountId,
    upstream: 'https://ws.boardsesh.com',
    graphql: [],
    static: [],
    capture: {
      sharedSessionId: sessionId,
      boards: ['Primary board', 'Second board'],
      cpp: {
        target,
        boardIds: { [primary.id]: boardId },
        boardReadyText: {},
        heroClimbs: {
          [primary.id]: { boardId, climbId, readyText: 'Recorded climb', gradeLabel: 'V3', statsAngle: board.angle },
        },
        scenes: {
          search: { boardId, readyText: 'Filters' },
          queue: { boardId, sessionId, readyText: 'Recorded climb' },
          status: { boardId, climbId, readyText: 'Recorded climb' },
          island: { boardId, readyText: 'Recorded climb' },
        },
      },
    },
  };
  const buildFixture = (
    operationName: string,
    query: string,
    variables: unknown,
    response: unknown,
  ): GraphqlFixtureFile => ({
    formatVersion: 1,
    ...graphqlFixtureKey({ operationName, query, variables }, sha256),
    query,
    variables,
    response,
    status: 200,
    recordedAt,
    upstream: manifest.upstream,
  });
  const roster = buildFixture('GetMyBoards', GET_MY_BOARDS, {}, rosterResponse);
  const search = buildFixture(
    'SearchClimbs',
    SEARCH_CLIMBS,
    {
      input: {
        boardName: board.boardType,
        layoutId: board.layoutId,
        sizeId: board.sizeId,
        setIds: board.setIds,
        angle: board.angle,
      },
    },
    searchResponse,
  );
  const joined = buildFixture('JoinSession', JOIN_SESSION, { sessionId, boardPath }, joinResponse);
  const queue = buildFixture('QueueUpdates', QUEUE_UPDATES_SUBSCRIPTION, { sessionId }, queueResponse);
  const fixtures = [roster, search, joined, queue];
  const reindex = () => {
    manifest.graphql = fixtures.map((fixture) => ({
      operationName: fixture.operationName,
      documentHash: fixture.documentHash,
      variablesHash: fixture.variablesHash,
      file: `graphql/${fixture.operationName}/${fixture.variablesHash.slice(0, 16)}.json`,
    }));
  };
  reindex();
  return {
    manifest,
    fixtures,
    reindex,
    primary,
    board,
    climb,
    joinedItem,
    queuedItem,
    joinState,
    queueState,
    joinResponse,
    queueResponse,
    rosterResponse,
    searchResponse,
    roster,
    search,
    joined,
    queue,
  };
}

function separateStatusScene() {
  const evidence = sample('moonboard');
  const current = {
    ...evidence.climb,
    uuid: '62f43f16-9ac8-59d7-8803-794268fec151',
    name: 'MOON GIRL',
    frames: 'p16r42p48r42p108r43',
  };
  Object.assign(evidence.queuedItem.climb, current);
  Object.assign(evidence.joinedItem.climb, current);
  evidence.searchResponse.data.searchClimbs.climbs.push({ ...current });
  const scenes = evidence.manifest.capture!.cpp!.scenes;
  scenes.status.climbId = current.uuid;
  scenes.status.readyText = current.name;
  scenes.island.readyText = current.name;
  scenes.queue.readyText = current.name;
  return evidence;
}

const temporaryDirectories: string[] = [];
const runningBackends: ScreenshotBackendServer[] = [];
afterEach(async () => {
  for (const backend of runningBackends.splice(0)) await backend.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function startReplay(evidence: ReturnType<typeof sample>) {
  const directory = mkdtempSync(join(tmpdir(), 'cpp-wall-confirmation-'));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(evidence.manifest));
  for (const entry of evidence.manifest.graphql) {
    mkdirSync(dirname(join(directory, entry.file)), { recursive: true });
    const fixture = evidence.fixtures.find(
      (fixture) => fixture.operationName === entry.operationName && fixture.variablesHash === entry.variablesHash,
    )!;
    writeFileSync(join(directory, entry.file), JSON.stringify(fixture));
  }
  const logLines: string[] = [];
  const backend = createScreenshotBackend({
    mode: 'replay',
    fixturesDir: directory,
    upstreamUrl: null,
    frozenNow: evidence.manifest.frozenNow,
    log: (line) => logLines.push(line),
  });
  runningBackends.push(backend);
  const port = await backend.listen(0, '127.0.0.1');
  return { origin: `http://127.0.0.1:${port}`, logLines, directory };
}

describe('CPP local hardware confirmation replay', () => {
  it('keeps physical confirmation disabled when the genuine Moon status/current scene differs from its hero', async () => {
    const evidence = separateStatusScene();
    const { origin, logLines } = await startReplay(evidence);
    const response = await fetch(`${origin}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: CONFIRM_CLIMB_ON_WALL,
        variables: { climbUuid: evidence.queuedItem.climb.uuid, queueItemUuid: queueItemId },
      }),
    });
    expect(await response.json()).toEqual(disabledResponse);
    expect(logLines.some((line) => line.includes('MISS'))).toBe(false);
    expect(evidence.manifest.capture!.cpp!.heroClimbs![evidence.primary.id].climbId).toBe(climbId);
  });
  it.each(['kilter', 'tension'] as const)(
    'refuses physical confirmation for the proven %s primary without a replay miss',
    async (target) => {
      const evidence = sample(target);
      const { origin, logLines, directory } = await startReplay(evidence);
      const response = await fetch(`${origin}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationName: 'ConfirmClimbOnWall',
          query: CONFIRM_CLIMB_ON_WALL,
          variables: { climbUuid: climbId },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(disabledResponse);
      expect(logLines.some((line) => line.includes('MISS'))).toBe(false);
      expect(logLines.some((line) => line.includes('DEFAULT graphql ConfirmClimbOnWall'))).toBe(true);
      expect(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))).toEqual(evidence.manifest);
    },
  );

  it('keeps the phone WS mutation disabled while rejecting an unrelated missing operation', async () => {
    const { origin, logLines } = await startReplay(sample());
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/graphql`, 'graphql-transport-ws');
    const messages: Array<{ id?: string; type: string; payload?: unknown }> = [];
    socket.on('message', (frame) => {
      const bytes = Array.isArray(frame) ? Buffer.concat(frame) : Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
      messages.push(JSON.parse(bytes.toString('utf8')));
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    try {
      socket.send(JSON.stringify({ type: 'connection_init' }));
      await expect.poll(() => messages.some((message) => message.type === 'connection_ack')).toBe(true);
      socket.send(
        JSON.stringify({
          id: 'confirm',
          type: 'subscribe',
          payload: {
            operationName: 'ConfirmClimbOnWall',
            query: CONFIRM_CLIMB_ON_WALL,
            variables: { climbUuid: climbId, queueItemUuid: queueItemId },
          },
        }),
      );
      await expect
        .poll(() => messages.some((message) => message.id === 'confirm' && message.type === 'complete'))
        .toBe(true);
      expect(messages.find((message) => message.id === 'confirm' && message.type === 'next')?.payload).toEqual(
        disabledResponse,
      );
      socket.send(
        JSON.stringify({
          id: 'other',
          type: 'subscribe',
          payload: {
            operationName: 'UnrecordedWrite',
            query: 'mutation UnrecordedWrite { unrecordedWrite }',
            variables: {},
          },
        }),
      );
      await expect
        .poll(() => messages.some((message) => message.id === 'other' && message.type === 'complete'))
        .toBe(true);
      expect(messages.find((message) => message.id === 'other' && message.type === 'next')?.payload).toMatchObject({
        errors: [{ extensions: { code: 'SCREENSHOT_FIXTURE_MISS' } }],
      });
      expect(logLines.filter((line) => line.includes('MISS'))).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => {
        socket.once('close', resolve);
        socket.close();
      });
    }
  });
});

type WallEvidence = ReturnType<typeof sample>;
const recognizes = (
  evidence: WallEvidence,
  variables: unknown = { climbUuid: climbId },
  query = CONFIRM_CLIMB_ON_WALL,
) => isCppWallConfirmation(query, variables, evidence.manifest, evidence.fixtures);
const rehash = (evidence: WallEvidence) => {
  for (const fixture of evidence.fixtures) Object.assign(fixture, graphqlFixtureKey(fixture, sha256));
  evidence.reindex();
};

describe('CPP wall-confirmation source bounds', () => {
  it('binds a distinct status/current scene while retaining its original independently proven hero', () => {
    const evidence = separateStatusScene();
    expect(recognizes(evidence, { climbUuid: evidence.queuedItem.climb.uuid, queueItemUuid: queueItemId })).toBe(true);
    expect(recognizes(evidence, { climbUuid: climbId })).toBe(false);
    expect(recognizes(evidence, { climbUuid: evidence.queuedItem.climb.uuid, queueItemUuid: 'foreign' })).toBe(false);
  });
  it.each([
    'status UUID',
    'status title',
    'island title',
    'hero UUID',
    'hero title',
    'hero source geometry',
    'contradicting hero frames',
    'current frames',
    'current geometry',
    'join leader',
    'participant leader',
    'source upstream',
  ])('rejects tampered %s on a distinct status/current scene', (change) => {
    const evidence = separateStatusScene();
    const coverage = evidence.manifest.capture!.cpp!;
    if (change === 'status UUID') coverage.scenes.status.climbId = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    if (change === 'status title') coverage.scenes.status.readyText = 'Changed status';
    if (change === 'island title') coverage.scenes.island.readyText = 'Changed island';
    if (change === 'hero UUID') coverage.heroClimbs![evidence.primary.id].climbId = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    if (change === 'hero title') coverage.heroClimbs![evidence.primary.id].readyText = 'Changed hero';
    if (change === 'hero source geometry') evidence.searchResponse.data.searchClimbs.climbs[0].angle = 35;
    if (change === 'contradicting hero frames')
      evidence.searchResponse.data.searchClimbs.climbs.push({ ...evidence.climb, frames: 'p9r42' });
    if (change === 'current frames') evidence.queuedItem.climb.frames = 'p9r42';
    if (change === 'current geometry') evidence.queuedItem.climb.angle = 35;
    if (change === 'join leader') evidence.joinResponse.data.joinSession.isLeader = false;
    if (change === 'participant leader') evidence.joinResponse.data.joinSession.users[0].isLeader = false;
    if (change === 'source upstream') evidence.joined.upstream = 'https://foreign.example';
    expect(recognizes(evidence, { climbUuid: evidence.queuedItem.climb.uuid })).toBe(false);
  });
  it.each(['kilter', 'tension'] as const)(
    'accepts only the current recorded %s climb, including its optional item identity',
    (target) => {
      const evidence = sample(target);
      expect(recognizes(evidence)).toBe(true);
      expect(recognizes(evidence, { climbUuid: climbId, queueItemUuid: queueItemId })).toBe(true);
      expect(recognizes(evidence, { climbUuid: climbId, queueItemUuid: null })).toBe(true);
      expect(
        recognizes(
          evidence,
          { climbUuid: climbId },
          CONFIRM_CLIMB_ON_WALL.replace('id\n      lastConnectedBoardSerial', 'lastConnectedBoardSerial\n      id'),
        ),
      ).toBe(true);
    },
  );

  it.each([
    null,
    [],
    {},
    { climbUuid: 'missing' },
    { climbUuid: climbId, queueItemUuid: 'foreign' },
    { climbUuid: climbId, boardPath: 'foreign' },
    { climbUuid: climbId, sessionId },
  ])('rejects unknown or differently scoped variables %j', (variables) => {
    expect(recognizes(sample(), variables)).toBe(false);
  });

  it.each([
    CONFIRM_CLIMB_ON_WALL.replace('climbUuid: $climbUuid', 'climbUuid: "foreign"'),
    CONFIRM_CLIMB_ON_WALL.replace('lastConnectedBoardSerial', 'isPublic'),
    CONFIRM_CLIMB_ON_WALL.replace('mutation ConfirmClimbOnWall', 'mutation OtherOperation'),
    'not GraphQL',
  ])('rejects changed confirmation documents', (query) => {
    expect(recognizes(sample(), { climbUuid: climbId }, query)).toBe(false);
  });

  const scopeChanges: Array<[string, (evidence: WallEvidence) => void]> = [
    [
      'campaign flow',
      (evidence) => {
        evidence.manifest.flow = 'app-store-campaign';
      },
    ],
    [
      'ordinary flow',
      (evidence) => {
        evidence.manifest.flow = 'app-store';
      },
    ],
    [
      'missing CPP capture',
      (evidence) => {
        delete evidence.manifest.capture!.cpp;
      },
    ],
    [
      'spray target',
      (evidence) => {
        evidence.manifest.capture!.cpp!.target = 'spray';
      },
    ],
    [
      'different target',
      (evidence) => {
        evidence.manifest.capture!.cpp!.target = 'tension';
      },
    ],
    [
      'foreign account',
      (evidence) => {
        evidence.manifest.accountUserId = sessionId;
      },
    ],
    [
      'missing account',
      (evidence) => {
        evidence.manifest.accountUserId = '';
      },
    ],
    [
      'foreign shared session',
      (evidence) => {
        evidence.manifest.capture!.sharedSessionId = boardId;
      },
    ],
    [
      'foreign queue session',
      (evidence) => {
        evidence.manifest.capture!.cpp!.scenes.queue.sessionId = boardId;
      },
    ],
    [
      'foreign primary UUID',
      (evidence) => {
        evidence.manifest.capture!.cpp!.boardIds![evidence.primary.id] = sessionId;
      },
    ],
    [
      'foreign hero board',
      (evidence) => {
        evidence.manifest.capture!.cpp!.heroClimbs![evidence.primary.id].boardId = sessionId;
      },
    ],
    [
      'foreign status climb',
      (evidence) => {
        evidence.manifest.capture!.cpp!.scenes.status.climbId = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
      },
    ],
    [
      'changed hero angle',
      (evidence) => {
        evidence.manifest.capture!.cpp!.heroClimbs![evidence.primary.id].statsAngle = 35;
      },
    ],
    [
      'invalid frozen time',
      (evidence) => {
        evidence.manifest.frozenNow = 'invalid';
      },
    ],
  ];
  it.each(scopeChanges)('rejects manifest scope changes: %s', (_label, mutate) => {
    const evidence = sample();
    mutate(evidence);
    expect(recognizes(evidence)).toBe(false);
  });

  it.each(['search', 'queue', 'status', 'island'])('rejects a foreign or missing %s scene board', (scene) => {
    const evidence = sample();
    evidence.manifest.capture!.cpp!.scenes[scene].boardId = sessionId;
    expect(recognizes(evidence)).toBe(false);
    delete evidence.manifest.capture!.cpp!.scenes[scene];
    expect(recognizes(evidence)).toBe(false);
  });

  const recordedChanges: Array<[string, (evidence: WallEvidence) => void]> = [
    [
      'foreign session participant',
      (evidence) => {
        evidence.joinResponse.data.joinSession.users[0].userId = boardId;
      },
    ],
    [
      'nonleader session participant',
      (evidence) => {
        evidence.joinResponse.data.joinSession.users[0].isLeader = false;
      },
    ],
    [
      'nonleader join',
      (evidence) => {
        evidence.joinResponse.data.joinSession.isLeader = false;
      },
    ],
    [
      'missing session participant',
      (evidence) => {
        evidence.joinResponse.data.joinSession.users = [];
      },
    ],
    [
      'foreign owner',
      (evidence) => {
        evidence.board.ownerId = sessionId;
      },
    ],
    [
      'public board',
      (evidence) => {
        evidence.board.isPublic = true;
      },
    ],
    [
      'noneditable board',
      (evidence) => {
        evidence.board.canEdit = false;
      },
    ],
    [
      'wrong board family',
      (evidence) => {
        evidence.board.boardType = 'tension';
      },
    ],
    [
      'wrong board layout',
      (evidence) => {
        evidence.board.layoutId += 1;
      },
    ],
    [
      'wrong board size',
      (evidence) => {
        evidence.board.sizeId += 1;
      },
    ],
    [
      'wrong board sets',
      (evidence) => {
        evidence.board.setIds = '1';
      },
    ],
    [
      'duplicated board sets',
      (evidence) => {
        evidence.board.setIds = '1,1,20';
      },
    ],
    [
      'wrong board angle',
      (evidence) => {
        evidence.board.angle = 35;
      },
    ],
    [
      'missing owned board',
      (evidence) => {
        evidence.rosterResponse.data.myBoards.boards = [];
      },
    ],
    [
      'ambiguous owned board',
      (evidence) => {
        evidence.rosterResponse.data.myBoards.boards.push({ ...evidence.board });
      },
    ],
    [
      'foreign join identity',
      (evidence) => {
        evidence.joinResponse.data.joinSession.id = boardId;
      },
    ],
    [
      'public joined session',
      (evidence) => {
        evidence.joinResponse.data.joinSession.isPublic = true;
      },
    ],
    [
      'different response path',
      (evidence) => {
        evidence.joinResponse.data.joinSession.boardPath += '/';
      },
    ],
    [
      'non-FullSync snapshot',
      (evidence) => {
        evidence.queueResponse.data.queueUpdates.__typename = 'QueueUpdate';
      },
    ],
    [
      'missing join current climb',
      (evidence) => {
        evidence.joinState.currentClimbQueueItem = null as unknown as typeof evidence.joinedItem;
      },
    ],
    [
      'missing sync current climb',
      (evidence) => {
        evidence.queueState.currentClimbQueueItem = null as unknown as typeof evidence.queuedItem;
      },
    ],
    [
      'different current item',
      (evidence) => {
        evidence.joinedItem.uuid = sessionId;
      },
    ],
    [
      'different current climb',
      (evidence) => {
        evidence.joinedItem.climb.uuid = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
      },
    ],
    [
      'different join frames',
      (evidence) => {
        evidence.joinedItem.climb.frames = 'p3r3';
      },
    ],
    [
      'different search frames',
      (evidence) => {
        evidence.searchResponse.data.searchClimbs.climbs[0].frames = 'p3r3';
      },
    ],
    [
      'empty frames everywhere',
      (evidence) => {
        evidence.joinedItem.climb.frames =
          evidence.queuedItem.climb.frames =
          evidence.searchResponse.data.searchClimbs.climbs[0].frames =
            '';
      },
    ],
    [
      'wrong current angle',
      (evidence) => {
        evidence.queuedItem.climb.angle = 35;
      },
    ],
    [
      'foreign queue family',
      (evidence) => {
        evidence.queuedItem.climb.boardType = 'tension';
      },
    ],
    [
      'foreign queue layout',
      (evidence) => {
        evidence.queuedItem.climb.layoutId += 1;
      },
    ],
    [
      'missing queued current item',
      (evidence) => {
        evidence.queueState.queue = [];
      },
    ],
    [
      'ambiguous queued current item',
      (evidence) => {
        evidence.queueState.queue.push({ ...evidence.queuedItem });
      },
    ],
    [
      'missing searched climb',
      (evidence) => {
        evidence.searchResponse.data.searchClimbs.climbs = [];
      },
    ],
    [
      'foreign join input session',
      (evidence) => {
        evidence.joined.variables = { sessionId: boardId, boardPath: evidence.joinResponse.data.joinSession.boardPath };
      },
    ],
    [
      'foreign queue input session',
      (evidence) => {
        evidence.queue.variables = { sessionId: boardId };
      },
    ],
    [
      'wrong input path geometry',
      (evidence) => {
        evidence.joined.variables = { sessionId, boardPath: 'kilter/1/11/1,20/40' };
        evidence.joinResponse.data.joinSession.boardPath = 'kilter/1/11/1,20/40';
      },
    ],
    [
      'foreign search input',
      (evidence) => {
        evidence.search.variables = {
          input: { boardName: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13', angle: 40 },
        };
      },
    ],
    [
      'changed recorded document',
      (evidence) => {
        evidence.queue.query = evidence.queue.query.replace('stateHashOrdered', 'foreignField');
      },
    ],
  ];
  it.each(recordedChanges)('rejects changed recorded evidence even after valid reindexing: %s', (_label, mutate) => {
    const evidence = sample();
    mutate(evidence);
    rehash(evidence);
    expect(recognizes(evidence)).toBe(false);
  });

  it.each(['GetMyBoards', 'SearchClimbs', 'JoinSession', 'QueueUpdates'])(
    'requires %s evidence with intact provenance',
    (operationName) => {
      const evidence = sample();
      evidence.fixtures.splice(
        evidence.fixtures.findIndex((fixture) => fixture.operationName === operationName),
        1,
      );
      evidence.reindex();
      expect(recognizes(evidence)).toBe(false);
    },
  );

  const provenanceChanges: Array<[string, (fixture: GraphqlFixtureFile) => void]> = [
    [
      'failed status',
      (fixture) => {
        fixture.status = 500;
      },
    ],
    [
      'foreign upstream',
      (fixture) => {
        fixture.upstream = 'https://foreign.example.test';
      },
    ],
    [
      'invalid timestamp',
      (fixture) => {
        fixture.recordedAt = 'invalid';
      },
    ],
    [
      'future timestamp',
      (fixture) => {
        fixture.recordedAt = '2026-10-14T00:00:00Z';
      },
    ],
    [
      'GraphQL errors',
      (fixture) => {
        fixture.response = { errors: [] };
      },
    ],
    [
      'changed query hash',
      (fixture) => {
        fixture.documentHash = 'f'.repeat(64);
      },
    ],
    [
      'changed variable hash',
      (fixture) => {
        fixture.variablesHash = 'f'.repeat(64);
      },
    ],
  ];
  for (const operationName of ['GetMyBoards', 'SearchClimbs', 'JoinSession', 'QueueUpdates']) {
    it.each(provenanceChanges)(`rejects ${operationName} provenance corruption: %s`, (_label, mutate) => {
      const evidence = sample();
      mutate(evidence.fixtures.find((fixture) => fixture.operationName === operationName)!);
      expect(recognizes(evidence)).toBe(false);
    });
  }

  it.each(['file', 'documentHash', 'variablesHash'] as const)('rejects altered manifest indexes: %s', (field) => {
    const evidence = sample();
    evidence.manifest.graphql[0][field] = field === 'file' ? 'graphql/GetMyBoards/../../foreign.json' : 'f'.repeat(64);
    expect(recognizes(evidence)).toBe(false);
  });
  it('rejects ambiguous fixture or manifest identities', () => {
    const duplicateFixture = sample();
    duplicateFixture.fixtures.push(duplicateFixture.queue);
    expect(recognizes(duplicateFixture)).toBe(false);
    const duplicateIndex = sample();
    duplicateIndex.manifest.graphql.push(duplicateIndex.manifest.graphql[0]);
    expect(recognizes(duplicateIndex)).toBe(false);
  });

  it('preserves a miss for a foreign confirmation over the real replay endpoint', async () => {
    const { origin, logLines } = await startReplay(sample());
    const response = await fetch(`${origin}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationName: 'ConfirmClimbOnWall',
        query: CONFIRM_CLIMB_ON_WALL,
        variables: { climbUuid: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
      }),
    });
    expect(await response.json()).toMatchObject({ errors: [{ extensions: { code: 'SCREENSHOT_FIXTURE_MISS' } }] });
    expect(logLines.some((line) => line.includes('MISS graphql ConfirmClimbOnWall'))).toBe(true);
    expect(logLines.some((line) => line.includes('DEFAULT graphql ConfirmClimbOnWall'))).toBe(false);
  });

  it('cannot return a recorded successful confirmation when CPP evidence is invalid', async () => {
    const evidence = sample();
    const variables = { climbUuid: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' };
    evidence.fixtures.push({
      ...evidence.joined,
      ...graphqlFixtureKey({ operationName: 'ConfirmClimbOnWall', query: CONFIRM_CLIMB_ON_WALL, variables }, sha256),
      query: CONFIRM_CLIMB_ON_WALL,
      variables,
      response: { data: { confirmClimbOnWall: { id: sessionId, lastConnectedBoardSerial: null } } },
    });
    evidence.reindex();
    const { origin } = await startReplay(evidence);
    const response = await fetch(`${origin}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationName: 'ConfirmClimbOnWall', query: CONFIRM_CLIMB_ON_WALL, variables }),
    });
    expect(await response.json()).toMatchObject({ errors: [{ extensions: { code: 'SCREENSHOT_FIXTURE_MISS' } }] });
  });
});
