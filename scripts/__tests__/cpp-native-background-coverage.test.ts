import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { GET_MY_BOARDS, QUEUE_UPDATES_SUBSCRIPTION } from '../../packages/mobile/src/lib/graphql/operations';
import { JOIN_SESSION } from '../../packages/shared/graphql/src/operations/queue-session';
import {
  assertCppNativeJoinResponse,
  assertCppNegativeFixtureFiles,
  fetchCppUnsupportedRender,
  readCppBackgroundFile,
  resolveCppNativeBackgroundPlan,
  withCppNativeBackgroundCoverage,
} from '../lib/cpp-native-background-coverage';
import { createFixtureSnapshotArchive } from '../lib/screenshot-fixture-archive';
import { decodeFixtureSnapshot, ensureScreenshotFixtures, snapshotHash } from '../lib/screenshot-fixture-snapshot';
import { createScreenshotBackend } from '../lib/screenshot-backend';
import { CPP_RECORDING_OWNER_QUERY } from '../lib/cpp-ws-recording';
import { CPP_BOOTSTRAP_PROFILE_QUERY } from '../bootstrap-cpp-scenario';
import { NATIVE_CAMPAIGN_JOIN_QUERY } from '../lib/screenshot-campaign-session';
import { readCppPage } from '../lib/screenshot-cpp';
import { createCppThumbnailRecording } from '../lib/cpp-beta-thumbnails';
import {
  graphqlFixtureKey,
  staticFixtureKey,
  validateScreenshotFixtureManifest,
  type ScreenshotFixtureManifest,
  type GraphqlFixtureFile,
} from '../lib/screenshot-fixtures';

const account = '11111111-1111-4111-8111-111111111111';
const session = '22222222-2222-4222-8222-222222222222';
const boardId = '33333333-3333-4333-8333-333333333333';
const timestamp = '2026-10-01T00:00:00.000Z';
const body = Buffer.from('{"error":"Invalid board configuration"}');
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const directories: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'cpp-background-test-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) await close();
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function sample(upstream = 'https://ws.boardsesh.com') {
  const primary = readCppPage('spray').primaryBoard;
  const board = {
    uuid: boardId,
    boardType: 'spray',
    ownerId: account,
    canEdit: true,
    isPublic: false,
    slug: 'home-spray-wall',
    layoutId: 47,
    sizeId: 47,
    setIds: '1',
    angle: 40,
  };
  const queue = [1, 2, 3].map((number) => ({
    uuid: `item-${number}`,
    climb: { uuid: `climb-${number}`, boardType: 'spray', layoutId: 47, angle: 40, frames: `p${number}r4p10r1` },
  }));
  const state = { queue, currentClimbQueueItem: queue[0] };
  const manifest: ScreenshotFixtureManifest = {
    formatVersion: 1,
    recordedAt: timestamp,
    frozenNow: timestamp,
    upstream,
    accountEmail: 'shots@example.test',
    accountUserId: account,
    flow: 'app-store-cpp',
    graphql: [],
    static: [],
    capture: {
      sharedSessionId: session,
      boards: ['Liz', 'Cherry'],
      cpp: {
        target: 'spray',
        boardIds: { [primary.id]: boardId },
        boardReadyText: {},
        scenes: {
          queue: { boardId, sessionId: session, readyText: 'Queue' },
          search: { boardId, readyText: 'Search' },
        },
      },
    },
  };
  const files = new Map<string, Buffer>();
  const fixtures: GraphqlFixtureFile[] = [];
  function add(operationName: string, query: string, variables: unknown, response: unknown) {
    const key = graphqlFixtureKey({ operationName, query, variables }, hash);
    const file = `graphql/${operationName}/${key.variablesHash.slice(0, 16)}.json`;
    const fixture: GraphqlFixtureFile = {
      formatVersion: 1,
      ...key,
      query,
      variables,
      response,
      status: 200,
      recordedAt: timestamp,
      upstream,
    };
    manifest.graphql.push({ ...key, file });
    fixtures.push(fixture);
    files.set(file, Buffer.from(JSON.stringify(fixture, null, 2) + '\n'));
    return fixture;
  }
  // The default native roster omits the primary; the genuine paginated roster owns it.
  add('GetMyBoards', GET_MY_BOARDS, {}, { data: { myBoards: { boards: [] } } });
  add('GetMyBoards', GET_MY_BOARDS, { input: { limit: 50, offset: 0 } }, { data: { myBoards: { boards: [board] } } });
  add(
    'JoinSession',
    JOIN_SESSION,
    { sessionId: session, boardPath: '/b/home-spray-wall/40' },
    {
      data: {
        joinSession: {
          id: session,
          boardPath: '/b/home-spray-wall/40',
          isPublic: false,
          isLeader: true,
          users: [{ userId: account, isLeader: true }],
          queueState: state,
        },
      },
    },
  );
  add(
    'QueueUpdates',
    QUEUE_UPDATES_SUBSCRIPTION,
    { sessionId: session },
    { data: { queueUpdates: { __typename: 'FullSync', state } } },
  );
  function plan() {
    return resolveCppNativeBackgroundPlan(manifest, fixtures)!;
  }
  function native() {
    const expected = plan().nativeJoin;
    add('JoinSession', expected.query, expected.variables, {
      data: { joinSession: { id: session, clientId: 'actual-client' } },
    });
  }
  function negative(request = plan().requests[0]) {
    const url = new URL(request, upstream);
    const file = `static/${staticFixtureKey(url.pathname, url.searchParams, hash)}.json`;
    files.set(file, body);
    manifest.static.push({
      path: url.pathname,
      query: url.searchParams.toString(),
      file,
      contentType: 'application/json',
      bytes: body.length,
      response: {
        status: 400,
        recordedAt: timestamp,
        sha256: hash(body),
        sources: plan().sourceFiles.map((file) => ({ file, sha256: hash(files.get(file)!) })),
      },
    });
  }
  function write(path = directory()) {
    files.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    for (const [file, bytes] of files) {
      mkdirSync(dirname(join(path, file)), { recursive: true });
      writeFileSync(join(path, file), bytes);
    }
    return path;
  }
  return { manifest, files, fixtures, board, state, plan, native, negative, write };
}

function packed(files: Map<string, Buffer>) {
  const compressed = gzipSync(
    JSON.stringify({
      version: 1,
      files: Object.fromEntries([...files].map(([file, bytes]) => [file, bytes.toString('base64')])),
    }),
  );
  return {
    compressed,
    reference: {
      version: 1 as const,
      url: 'https://example.com/fixture.gz',
      sha256: snapshotHash(compressed),
      bytes: compressed.length,
      files: files.size,
    },
  };
}

describe('genuine native background request scope', () => {
  it('uses the real paginated owned primary, current and adjacent climbs only', () => {
    const source = sample(),
      plan = source.plan();
    expect(plan.nativeJoin.variables).toEqual({ sessionId: session, boardPath: '/spray/47/47/1/0' });
    expect(plan.nativeJoin.query).toBe(NATIVE_CAMPAIGN_JOIN_QUERY);
    expect(plan.sourceFiles).toHaveLength(4);
    expect(plan.requests).toHaveLength(2);
    expect(
      plan.requests.every((request) => request.includes('board_name=spray') && request.includes('dim_background=0.18')),
    ).toBe(true);
    expect(plan.requests.some((request) => request.includes('frames=p3r4'))).toBe(false);
  });
  it.each(['owner', 'public', 'editable', 'frames', 'layout', 'document', 'status', 'time', 'queue'])(
    'rejects changed %s provenance',
    (failure) => {
      const source = sample();
      if (failure === 'owner') source.board.ownerId = 'another-owner';
      if (failure === 'public') source.board.isPublic = true;
      if (failure === 'editable') source.board.canEdit = false;
      if (failure === 'frames') source.state.queue[0].climb.frames = 'url=http://private';
      if (failure === 'layout') source.state.queue[0].climb.layoutId = 99;
      if (failure === 'document') source.fixtures[1].query += '\nquery Secret { profile { id } }';
      if (failure === 'status') source.fixtures[1].status = 403;
      if (failure === 'time') source.fixtures[1].recordedAt = '2099-01-01';
      if (failure === 'queue')
        source.fixtures[3].response = {
          data: { queueUpdates: { __typename: 'FullSync', state: { queue: [], currentClimbQueueItem: null } } },
        };
      expect(source.plan).toThrow();
    },
  );
  it('rejects conflicting primary ownership across the two actual roster variants', () => {
    const source = sample();
    source.fixtures[0].response = { data: { myBoards: { boards: [{ ...source.board, ownerId: 'someone-else' }] } } };
    expect(source.plan).toThrow();
  });
  it('requires the exact minimal response and same session', () => {
    expect(() =>
      assertCppNativeJoinResponse({ data: { joinSession: { id: session, clientId: 'original' } } }, session),
    ).not.toThrow();
    for (const response of [
      { data: { joinSession: { id: 'other', clientId: 'original' } } },
      { data: { joinSession: { id: session, clientId: 'original', token: 'secret' } } },
      { errors: [], data: {} },
    ])
      expect(() => assertCppNativeJoinResponse(response, session)).toThrow();
  });
});

describe('recorded unsupported renderer response', () => {
  it('preserves the exact body and records only the derived unauthenticated request', async () => {
    const plan = sample().plan(),
      bytes = Buffer.from(' { "error" : "Invalid board configuration" }\n');
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(bytes, { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } }),
      );
    const received = await fetchCppUnsupportedRender('https://ws.boardsesh.com', plan.requests[0], plan, request);
    expect(received.bytes.equals(bytes)).toBe(true);
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    expect(request.mock.calls[0][1]?.headers).toBeUndefined();
    expect(received.sourceUrl).toBe(`https://ws.boardsesh.com${plan.requests[0]}`);
  });
  it.each([200, 301, 401, 403, 404, 429, 500, 503])('rejects HTTP %s without a fallback response', async (status) => {
    const plan = sample().plan();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status, headers: { 'content-type': 'application/json' } }));
    await expect(
      fetchCppUnsupportedRender('https://ws.boardsesh.com', plan.requests[0], plan, request),
    ).rejects.toThrow('genuine response recording failed');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(['html', 'wrong error', 'extra field', 'oversize', 'length', 'network'])(
    'rejects %s and hides raw failure excerpts',
    async (failure) => {
      const plan = sample().plan();
      const request = vi.fn<typeof fetch>();
      const bytes =
        failure === 'oversize'
          ? Buffer.alloc(1025)
          : failure === 'wrong error'
            ? Buffer.from('{"error":"Invalid board_name"}')
            : failure === 'extra field'
              ? Buffer.from('{"error":"Invalid board configuration","secret":"token"}')
              : body;
      if (failure === 'network') request.mockRejectedValue(new Error('SECRET upstream body'));
      else
        request.mockResolvedValue(
          new Response(bytes, {
            status: 400,
            headers: {
              'content-type': failure === 'html' ? 'text/html' : 'application/json',
              ...(failure === 'length' ? { 'content-length': '999' } : {}),
            },
          }),
        );
      await expect(
        fetchCppUnsupportedRender('https://ws.boardsesh.com', plan.requests[0], plan, request),
      ).rejects.toThrow(/^CPP native render genuine response recording failed$/);
    },
  );
  it('cannot count an actual JSON error as a beta thumbnail', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { status: 400, headers: { 'content-type': 'application/json' } }),
    );
    const path = '/static/beta-link-thumbnails/instagram/original.jpg';
    const recorder = createCppThumbnailRecording('https://ws.boardsesh.com', new Set([`${path}?size=280`]));
    await expect(recorder.download(path, 'size=280')).rejects.toThrow('genuine image download failed');
    expect(recorder.proofs).toEqual([]);
  });
});

describe('negative response delivery boundaries', () => {
  it.each([
    'body',
    'hash',
    'source',
    'timestamp',
    'filename',
    'request',
    'metadata',
    'source metadata',
    'status',
    'duplicate',
    'invalid frozen clock',
    'source format',
  ])('rejects %s tampering at archive creation and snapshot decode', (failure) => {
    const source = sample();
    source.negative();
    const entry = source.manifest.static[0];
    if (failure === 'body') source.files.set(entry.file, Buffer.from('not the actual body'));
    if (failure === 'hash') entry.response!.sha256 = '0'.repeat(64);
    if (failure === 'source') entry.response!.sources[0].sha256 = '0'.repeat(64);
    if (failure === 'invalid frozen clock') source.manifest.frozenNow = 'not-an-instant';
    if (failure === 'source format') {
      const file = source.plan().sourceFiles[0];
      const fixture = JSON.parse(source.files.get(file)!.toString('utf8')) as GraphqlFixtureFile;
      Object.assign(fixture, { formatVersion: 2 });
      source.files.set(file, Buffer.from(JSON.stringify(fixture)));
      entry.response!.sources.find((source) => source.file === file)!.sha256 = hash(source.files.get(file)!);
    }
    if (failure === 'timestamp') entry.response!.recordedAt = '2099-01-01';
    if (failure === 'filename') {
      source.files.set('static/wrong.json', body);
      entry.file = 'static/wrong.json';
    }
    if (failure === 'request') entry.query += '&token=forbidden';
    if (failure === 'metadata') Object.assign(entry.response!, { token: 'forbidden' });
    if (failure === 'source metadata') Object.assign(entry.response!.sources[0], { token: 'forbidden' });
    if (failure === 'status') Object.assign(entry.response!, { status: 200 });
    if (failure === 'duplicate') source.manifest.static.push({ ...entry });
    const path = source.write(),
      archive = packed(source.files);
    expect(() => createFixtureSnapshotArchive(path)).toThrow();
    expect(() => decodeFixtureSnapshot(archive.compressed, archive.reference)).toThrow();
    expect(() =>
      createScreenshotBackend({
        mode: 'replay',
        upstreamUrl: null,
        fixturesDir: path,
        frozenNow: timestamp,
        log: () => undefined,
      }),
    ).toThrow();
  });
  it('preserves successful shared image files and HTTP 200 while negative entries replay actual 400 bytes', async () => {
    const source = sample();
    source.negative();
    source.files.set('static/shared.jpg', Buffer.from('unchanged image'));
    for (const path of ['/static/one.jpg', '/static/two.jpg'])
      source.manifest.static.push({ path, query: '', file: 'static/shared.jpg', bytes: 15, contentType: 'image/jpeg' });
    const path = source.write(),
      archive = createFixtureSnapshotArchive(path);
    const decoded = decodeFixtureSnapshot(archive.compressed, archive.reference);
    expect(decoded.get(source.manifest.static[0].file)?.equals(body)).toBe(true);
    const backend = createScreenshotBackend({
      mode: 'replay',
      upstreamUrl: null,
      fixturesDir: path,
      frozenNow: timestamp,
      log: () => undefined,
    });
    cleanup.push(() => backend.close());
    const port = await backend.listen(0, '127.0.0.1');
    const negative = await fetch(`http://127.0.0.1:${port}${source.plan().requests[0]}`);
    expect(negative.status).toBe(400);
    expect(Buffer.from(await negative.arrayBuffer()).equals(body)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/static/two.jpg`)).status).toBe(200);
    expect(backend.stats().misses).toBe(0);
  });
  it('validates a freshly downloaded pinned archive before installing any files', async () => {
    const source = sample();
    source.negative();
    source.manifest.static[0].response!.sha256 = '0'.repeat(64);
    source.write();
    const archive = packed(source.files);
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(archive.compressed));
    await expect(ensureScreenshotFixtures(archive.reference, directory(), request)).rejects.toThrow();
  });
  it('counts a same-length negative body changed after startup as a strict replay miss', async () => {
    const source = sample();
    source.negative();
    const path = source.write();
    const logs: string[] = [];
    const backend = createScreenshotBackend({
      mode: 'replay',
      upstreamUrl: null,
      fixturesDir: path,
      frozenNow: timestamp,
      log: (line) => logs.push(line),
    });
    cleanup.push(() => backend.close());
    const port = await backend.listen(0, '127.0.0.1');
    const changed = Buffer.from(body);
    changed[changed.length - 3] = 120;
    writeFileSync(join(path, source.manifest.static[0].file), changed);
    const response = await fetch(`http://127.0.0.1:${port}${source.plan().requests[0]}`);
    expect(response.status).toBe(404);
    expect(backend.stats()).toMatchObject({ misses: 1, hits: 0 });
    expect(logs.some((line) => line.includes('MISS static'))).toBe(true);
    expect(logs.some((line) => line.includes('HIT static'))).toBe(false);
  });
  it('rejects symlinked and oversized negative bodies before reading', () => {
    const source = sample();
    source.negative();
    const path = source.write(),
      entry = source.manifest.static[0];
    const outside = join(directory(), 'outside.json');
    writeFileSync(outside, body);
    rmSync(join(path, entry.file));
    symlinkSync(outside, join(path, entry.file));
    expect(() => createFixtureSnapshotArchive(path)).toThrow();
    rmSync(join(path, entry.file));
    writeFileSync(join(path, entry.file), Buffer.alloc(1025));
    expect(() => readCppBackgroundFile(path, entry.file)).toThrow();
  });
});

describe('bounded background completion', () => {
  function authMocks(owner = account) {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ jwt: 'memory-only-secret' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { profile: { id: owner } } })));
  }
  it('freshly authenticates a complete resume without another join, fetch, byte or clock change', async () => {
    const source = sample();
    source.native();
    for (const request of source.plan().requests) source.negative(request);
    const path = source.write(),
      before = readFileSync(join(path, 'manifest.json'));
    const request = authMocks();
    await withCppNativeBackgroundCoverage(
      path,
      { upstream: source.manifest.upstream, email: source.manifest.accountEmail, password: 'unit-secret' },
      async (recording) => {
        expect(readFileSync(join(recording, 'manifest.json')).equals(before)).toBe(true);
        for (const [file, bytes] of source.files) expect(readFileSync(join(recording, file)).equals(bytes)).toBe(true);
      },
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      `${source.manifest.upstream}/auth/native/credentials`,
      `${source.manifest.upstream}/graphql`,
    ]);
  });
  it.each(['auth JSON', 'profile JSON', 'wrong owner'])(
    'sanitizes %s failure and never prepares a candidate',
    async (failure) => {
      const source = sample();
      source.native();
      source.plan().requests.forEach(source.negative);
      const request = vi.spyOn(globalThis, 'fetch');
      request.mockResolvedValueOnce(
        new Response(failure === 'auth JSON' ? 'SECRET-AUTH' : '{"jwt":"memory-only-secret"}'),
      );
      request.mockResolvedValueOnce(
        new Response(failure === 'profile JSON' ? 'SECRET-PROFILE' : '{"data":{"profile":{"id":"other"}}}'),
      );
      const prepare = vi.fn();
      await expect(
        withCppNativeBackgroundCoverage(
          source.write(),
          { upstream: source.manifest.upstream, email: source.manifest.accountEmail, password: 'unit-secret' },
          prepare,
        ),
      ).rejects.toThrow(/^CPP native background authentication failed$/);
      expect(prepare).not.toHaveBeenCalled();
    },
  );
  it('completes only the missing actual HTTP response without re-recording an existing native join', async () => {
    const source = sample();
    source.native();
    source.negative();
    const path = source.write();
    const request = authMocks().mockResolvedValueOnce(
      new Response(body, { status: 400, headers: { 'content-type': 'application/json' } }),
    );
    await withCppNativeBackgroundCoverage(
      path,
      { upstream: source.manifest.upstream, email: source.manifest.accountEmail, password: 'unit-secret' },
      async (recording) => {
        const manifest = JSON.parse(
          readFileSync(join(recording, 'manifest.json'), 'utf8'),
        ) as ScreenshotFixtureManifest;
        expect(manifest.static).toHaveLength(2);
        assertCppNegativeFixtureFiles(manifest, (file) => readFileSync(join(recording, file)));
        for (const [file, bytes] of source.files)
          if (file !== 'manifest.json') expect(readFileSync(join(recording, file)).equals(bytes)).toBe(true);
      },
    );
    expect(request).toHaveBeenCalledTimes(3);
    for (const [file, bytes] of source.files) expect(readFileSync(join(path, file)).equals(bytes)).toBe(true);
  });
  it('records exactly the authenticated minimal native join plus two genuine HTTP errors', async () => {
    const server = createServer(),
      sockets = new WebSocketServer({ server });
    const subscriptions: Array<{ query: string; variables: unknown }> = [];
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing port');
    const origin = `http://127.0.0.1:${address.port}`,
      source = sample(origin);
    const token = `unit.${Buffer.from(JSON.stringify({ sub: account })).toString('base64url')}.unit-signature`;
    server.on('request', (incoming, outgoing) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        outgoing.setHeader('content-type', 'application/json');
        if (incoming.url === '/auth/native/credentials') {
          outgoing.end(JSON.stringify({ jwt: token }));
          return;
        }
        if (incoming.url?.startsWith('/api/internal/board-render?')) {
          outgoing.statusCode = 400;
          outgoing.end(body);
          return;
        }
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { query: string };
        const profile = { id: account, displayName: 'Screenshot Climber', avatarUrl: null };
        if (request.query === CPP_BOOTSTRAP_PROFILE_QUERY) outgoing.end(JSON.stringify({ data: { profile } }));
        else if (request.query === CPP_RECORDING_OWNER_QUERY)
          outgoing.end(
            JSON.stringify({
              data: {
                profile,
                sessionStatus: 'active',
                mySessions: [
                  {
                    id: session,
                    boardPath: '/b/home-spray-wall/40',
                    createdByUserId: account,
                    isPublic: false,
                    isActive: true,
                  },
                ],
                board: source.board,
              },
            }),
          );
        else {
          outgoing.statusCode = 400;
          outgoing.end('{"error":"unexpected query"}');
        }
      })();
    });
    sockets.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const frame = JSON.parse(bytes.toString('utf8')) as {
          type: string;
          id: string;
          payload: { query: string; variables: unknown };
        };
        if (frame.type === 'connection_init') socket.send('{"type":"connection_ack"}');
        if (frame.type !== 'subscribe') return;
        subscriptions.push(frame.payload);
        const result =
          frame.payload.query === NATIVE_CAMPAIGN_JOIN_QUERY
            ? { id: session, clientId: 'actual-new-client' }
            : { id: session, isPublic: false, boardPath: '/b/home-spray-wall/40' };
        socket.send(JSON.stringify({ id: frame.id, type: 'next', payload: { data: { joinSession: result } } }));
        socket.send(JSON.stringify({ id: frame.id, type: 'complete' }));
      }),
    );
    cleanup.push(async () => {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    });
    const path = source.write(),
      messages: string[] = [];
    await withCppNativeBackgroundCoverage(
      path,
      {
        upstream: origin,
        email: source.manifest.accountEmail,
        password: 'unit-secret',
        log: (line) => messages.push(line),
      },
      async (recording) => {
        const manifest = JSON.parse(
          readFileSync(join(recording, 'manifest.json'), 'utf8'),
        ) as ScreenshotFixtureManifest;
        expect(manifest.graphql).toHaveLength(source.manifest.graphql.length + 2);
        expect(manifest.static).toHaveLength(2);
        expect(validateScreenshotFixtureManifest(manifest).ok).toBe(true);
        assertCppNegativeFixtureFiles(manifest, (file) => readFileSync(join(recording, file)));
        const expected = graphqlFixtureKey(source.plan().nativeJoin, hash);
        const entry = manifest.graphql.find((entry) => entry.variablesHash === expected.variablesHash)!;
        expect(JSON.parse(readFileSync(join(recording, entry.file), 'utf8')).response).toEqual({
          data: { joinSession: { id: session, clientId: 'actual-new-client' } },
        });
        expect(readFileSync(join(recording, entry.file), 'utf8')).not.toContain(token);
      },
    );
    expect(subscriptions.map(({ query }) => query)).toEqual([JOIN_SESSION, NATIVE_CAMPAIGN_JOIN_QUERY]);
    expect(subscriptions[1].variables).toEqual(source.plan().nativeJoin.variables);
    for (const [file, bytes] of source.files) expect(readFileSync(join(path, file)).equals(bytes)).toBe(true);
    expect(messages.join('\n')).not.toContain(token);
    expect(messages.join('\n')).not.toContain('unit-secret');
  });
});
