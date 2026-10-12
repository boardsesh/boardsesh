import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { buildSchema, parse, validate } from 'graphql';
import { typeDefs } from '../../packages/shared-schema/src/schema';
import { JOIN_SESSION, NATIVE_IOS_QUEUE_UPDATES } from '../../packages/shared/graphql/src/operations/queue-session';
import { NATIVE_CAMPAIGN_JOIN_QUERY, replayCampaignSessionResponse } from '../lib/screenshot-campaign-session';
import type { GraphqlFixtureFile } from '../lib/screenshot-fixtures';
import {
  GET_SESSION,
  GET_PROFILE,
  QUEUE_UPDATES_SUBSCRIPTION,
  SESSION_UPDATES_SUBSCRIPTION,
} from '../../packages/mobile/src/lib/graphql/operations';
import { CPP_RECORDING_OWNER_QUERY, createCppWsRecording, type CppRecordingScope } from '../lib/cpp-ws-recording';
import {
  createScreenshotBackend,
  listFixtureFiles,
  readScreenshotFixtureManifest,
  type ScreenshotBackendServer,
} from '../lib/screenshot-backend';

const SESSION = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'memory-only-credential';
const PATH = 'kilter/1/10/1,20/40';
const queueSnapshot = {
  __typename: 'FullSync',
  sequence: 7,
  state: {
    sequence: 7,
    stateHash: 'actual-state-hash',
    stateHashOrdered: 'actual-ordered-hash',
    currentClimbQueueItem: null,
    queue: [
      {
        uuid: 'genuine-queue-item',
        addedBy: ACCOUNT,
        suggested: false,
        climb: {
          uuid: 'genuine-climb',
          setter_username: 'Actual setter',
          name: 'Actual climb',
          frames: 'p1r12',
          framesCount: 1,
          framesPace: 1000,
          angle: 40,
          ascensionist_count: 5,
          difficulty: 15,
          quality_average: 3,
          stars: 3,
          difficulty_error: 0,
          mirrored: false,
          benchmark_difficulty: null,
        },
      },
    ],
  },
};
const scope: CppRecordingScope = {
  accountUserId: ACCOUNT,
  sessionId: SESSION,
  boardUuid: 'primary-board',
  primary: { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: [1, 20], angle: 40 },
};

describe('genuine scoped CPP WS recording', () => {
  const http = createServer();
  const sockets = new WebSocketServer({ server: http });
  const peers = new Set<WebSocket>();
  const received: Array<{
    type: string;
    payload?: { query?: string; variables?: Record<string, unknown>; authToken?: string };
  }> = [];
  let origin: string;
  let owner: {
    sessionStatus: string;
    profile: { id: string; displayName: string; avatarUrl: null };
    mySessions: Array<{ id: string; boardPath: string; createdByUserId: string; isPublic: boolean; isActive: boolean }>;
    board: {
      uuid: string;
      ownerId: string;
      boardType: string;
      layoutId: number;
      sizeId: number;
      setIds: string;
      angle: number;
    };
  };
  let bridge: ReturnType<typeof createCppWsRecording> | undefined;
  let recorder: ScreenshotBackendServer | undefined;
  let recordingDir: string | undefined;
  let joinOverride: { id?: string; boardPath?: string; isPublic?: boolean } | undefined;
  const persist = vi.fn();
  const request = vi.fn<typeof fetch>();
  beforeEach(async () => {
    received.splice(0);
    persist.mockReset();
    request.mockReset();
    joinOverride = undefined;
    owner = {
      sessionStatus: 'active',
      profile: { id: ACCOUNT, displayName: 'Actual account name', avatarUrl: null },
      mySessions: [{ id: SESSION, boardPath: PATH, createdByUserId: ACCOUNT, isPublic: false, isActive: false }],
      board: {
        uuid: 'primary-board',
        ownerId: ACCOUNT,
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '20,1',
        angle: 40,
      },
    };
    request.mockImplementation(async () => new Response(JSON.stringify({ data: owner })));
    sockets.on('connection', (socket) => {
      peers.add(socket);
      socket.on('close', () => peers.delete(socket));
      socket.on('message', (bytes) => {
        const text = Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
        const frame = JSON.parse(text.toString('utf8')) as {
          id?: string;
          type: string;
          payload?: { query?: string; variables?: Record<string, unknown>; authToken?: string };
        };
        received.push(frame);
        if (frame.type === 'connection_init') socket.send(JSON.stringify({ type: 'connection_ack' }));
        else if (frame.type === 'subscribe') {
          let data: unknown;
          if (frame.payload?.query === NATIVE_CAMPAIGN_JOIN_QUERY)
            data = { joinSession: { id: SESSION, clientId: 'actual-client' } };
          else if (frame.payload?.query === JOIN_SESSION)
            data = {
              joinSession: {
                id: SESSION,
                clientId: 'actual-client',
                boardPath: PATH,
                isPublic: false,
                users: [{ id: ACCOUNT, username: owner.profile.displayName }],
                queueState: { queue: [{ uuid: 'genuine-queue-item' }] },
                ...(frame.id !== 'presence' ? joinOverride : {}),
              },
            };
          else if ([QUEUE_UPDATES_SUBSCRIPTION, NATIVE_IOS_QUEUE_UPDATES].includes(frame.payload?.query ?? ''))
            data = { queueUpdates: queueSnapshot };
          else
            data = {
              sessionUpdates: {
                __typename: 'SessionRosterSnapshot',
                users: [{ id: ACCOUNT, username: owner.profile.displayName }],
              },
            };
          socket.send(JSON.stringify({ id: frame.id, type: 'next', payload: { data } }));
          if ([JOIN_SESSION, NATIVE_CAMPAIGN_JOIN_QUERY].includes(frame.payload?.query ?? ''))
            socket.send(JSON.stringify({ id: frame.id, type: 'complete' }));
        }
      });
    });
    http.on('request', (incoming, outgoing) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const operation = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { query: string };
        const data =
          operation.query === CPP_RECORDING_OWNER_QUERY
            ? owner
            : operation.query === GET_PROFILE
              ? { profile: { ...owner.profile, email: 'shots@example.test' } }
              : {
                  session: peers.size
                    ? {
                        id: SESSION,
                        boardPath: PATH,
                        isPublic: false,
                        users: [{ id: ACCOUNT, username: owner.profile.displayName }],
                      }
                    : null,
                };
        outgoing.writeHead(200, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ data }));
      })();
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing test upstream');
    origin = `http://127.0.0.1:${address.port}`;
    bridge = createCppWsRecording({
      upstreamUrl: origin,
      scope: () => scope,
      authorizeToken: (token) => token === TOKEN,
      persist,
      request,
    });
  });
  afterEach(async () => {
    await recorder?.close();
    recorder = undefined;
    bridge?.close();
    for (const socket of peers) socket.terminate();
    await vi.waitFor(() => expect(peers.size).toBe(0));
    sockets.removeAllListeners('connection');
    http.removeAllListeners('request');
    await new Promise<void>((resolve) => http.close(() => resolve()));
    if (recordingDir) rmSync(recordingDir, { recursive: true, force: true });
    recordingDir = undefined;
    vi.unstubAllEnvs();
  });

  it('validates the actual read-only ownership document against the backend schema', () => {
    expect(validate(buildSchema(typeDefs.join('\n')), parse(CPP_RECORDING_OWNER_QUERY))).toEqual([]);
  });

  it('wakes a dormant private preview through a genuine join and keeps exactly one real connection alive', async () => {
    await bridge!.preparePreview({ query: GET_SESSION, variables: { sessionId: SESSION } }, TOKEN);
    expect(peers.size).toBe(1);
    expect(received[0]).toMatchObject({ type: 'connection_init', payload: { authToken: TOKEN } });
    const presence = received.find((frame) => frame.type === 'subscribe');
    expect(presence?.payload?.variables).toEqual({
      sessionId: SESSION,
      boardPath: PATH,
      username: 'Actual account name',
      avatarUrl: null,
    });
    expect(persist).not.toHaveBeenCalled();
    expect(request.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    bridge!.close();
    await vi.waitFor(() => expect(peers.size).toBe(0));
  });

  it('relays real native JOIN and both initial snapshots and retains presence after local completion', async () => {
    const frames: unknown[] = [];
    await bridge!.preparePreview({ query: GET_SESSION, variables: { sessionId: SESSION } }, TOKEN);
    const joined = await bridge!.subscribe(
      'native-join',
      {
        query: JOIN_SESSION,
        variables: { sessionId: SESSION, boardPath: PATH, username: owner.profile.displayName, avatarUrl: null },
      },
      TOKEN,
      (frame) => frames.push(frame),
    );
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    joined?.();
    const queue = await bridge!.subscribe(
      'native-queue',
      { query: QUEUE_UPDATES_SUBSCRIPTION, variables: { sessionId: SESSION } },
      TOKEN,
      (frame) => frames.push(frame),
    );
    const roster = await bridge!.subscribe(
      'native-roster',
      { query: SESSION_UPDATES_SUBSCRIPTION, variables: { sessionId: SESSION } },
      TOKEN,
      (frame) => frames.push(frame),
    );
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(3));
    expect(frames).toContainEqual({
      id: 'native-queue',
      type: 'next',
      payload: {
        data: { queueUpdates: queueSnapshot },
      },
    });
    expect(peers.size).toBe(1);
    queue?.();
    roster?.();
    expect(peers.size).toBe(1);
    expect(JSON.stringify(persist.mock.calls)).not.toContain(TOKEN);
    expect(
      received
        .filter((frame) => frame.type === 'subscribe')
        .every((frame) => !Object.hasOwn(frame.payload?.variables ?? {}, 'initialQueue')),
    ).toBe(true);
  });

  it.each(['owner', 'private', 'board', 'geometry', 'ended', 'profile'])(
    'refuses %s scope changes before joining',
    async (changed) => {
      if (changed === 'owner') owner.mySessions[0].createdByUserId = 'other-account';
      if (changed === 'private') owner.mySessions[0].isPublic = true;
      if (changed === 'board') owner.board.uuid = 'other-board';
      if (changed === 'geometry') owner.board.sizeId = 19;
      if (changed === 'ended') owner.sessionStatus = 'ended';
      if (changed === 'profile') owner.profile.id = 'other-account';
      await expect(
        bridge!.preparePreview({ query: GET_SESSION, variables: { sessionId: SESSION } }, TOKEN),
      ).rejects.toThrow('validation failed');
      expect(received).toEqual([]);
    },
  );

  it('does not contact upstream for other previews, passive streams or queue mutation inputs', async () => {
    await bridge!.preparePreview({ query: GET_SESSION, variables: { sessionId: 'other-session' } }, TOKEN);
    expect(
      await bridge!.subscribe('passive', { query: 'subscription PrivacyChanged { privacyChanged }' }, TOKEN, () => {}),
    ).toBeNull();
    for (const variables of [
      { sessionId: 'other-session', boardPath: PATH },
      { sessionId: SESSION, boardPath: PATH, initialQueue: [] },
      { sessionId: SESSION, boardPath: PATH, participantId: ACCOUNT },
      { sessionId: SESSION, boardPath: PATH, sessionName: 'replacement' },
    ])
      await expect(bridge!.subscribe('forbidden', { query: JOIN_SESSION, variables }, TOKEN, () => {})).rejects.toThrow(
        'validation failed',
      );
    expect(request).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  it('does not open a connection after capture closes during ownership verification', async () => {
    let release: (() => void) | undefined;
    request.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response(JSON.stringify({ data: owner }));
    });
    const pending = bridge!.preparePreview({ query: GET_SESSION, variables: { sessionId: SESSION } }, TOKEN);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    bridge!.close();
    release!();
    await expect(pending).rejects.toThrow('validation failed');
    expect(peers.size).toBe(0);
    expect(received).toEqual([]);
  });

  it.each(['id', 'boardPath', 'isPublic'] as const)(
    'rejects an upstream native join with changed %s before persistence or relay',
    async (field) => {
      joinOverride = field === 'isPublic' ? { isPublic: true } : { [field]: 'another-scope' };
      const frames: Array<{ type: string }> = [];
      await bridge!.subscribe(
        'native-join',
        { query: JOIN_SESSION, variables: { sessionId: SESSION, boardPath: PATH } },
        TOKEN,
        (frame) => frames.push(frame),
      );
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(frames[0].type).toBe('error');
      expect(persist).not.toHaveBeenCalled();
    },
  );

  it('suppresses a cancelled native operation while allowing a replacement with the same local ID', async () => {
    let release: (() => void) | undefined;
    request.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response(JSON.stringify({ data: owner }));
    });
    let current = true;
    const operation = { query: JOIN_SESSION, variables: { sessionId: SESSION, boardPath: PATH } };
    const staleFrames: unknown[] = [];
    const stale = bridge!.subscribe(
      'reused',
      operation,
      TOKEN,
      (frame) => staleFrames.push(frame),
      () => current,
    );
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    current = false;
    release!();
    expect(await stale).toBeNull();
    const frames: unknown[] = [];
    await bridge!.subscribe('reused', operation, TOKEN, (frame) => frames.push(frame));
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(staleFrames).toEqual([]);
    expect(received.filter((frame) => frame.payload?.query === JOIN_SESSION)).toHaveLength(2);
  });

  it('relays later live events while persisting only the genuine initial snapshot', async () => {
    const frames: unknown[] = [];
    await bridge!.subscribe(
      'queue',
      { query: QUEUE_UPDATES_SUBSCRIPTION, variables: { sessionId: SESSION } },
      TOKEN,
      (frame) => frames.push(frame),
    );
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    const subscribed = received.find((frame) => frame.payload?.query === QUEUE_UPDATES_SUBSCRIPTION) as { id?: string };
    const upstream = [...peers][0];
    upstream.send(
      JSON.stringify({
        id: subscribed.id,
        type: 'next',
        payload: { data: { queueUpdates: { __typename: 'QueueItemAdded', sequence: 2 } } },
      }),
    );
    upstream.send(
      JSON.stringify({
        id: subscribed.id,
        type: 'next',
        payload: { data: { queueUpdates: { __typename: 'FullSync', sequence: 3 } } },
      }),
    );
    await vi.waitFor(() => expect(frames).toHaveLength(3));
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('relays minimal iOS responses first but records only the later actual full RN source', async () => {
    const frames: unknown[] = [];
    await bridge!.subscribe(
      'ios-join',
      { query: NATIVE_CAMPAIGN_JOIN_QUERY, variables: { sessionId: SESSION, boardPath: '/kilter/1/10/1,20/0' } },
      TOKEN,
      (frame) => frames.push(frame),
    );
    await bridge!.subscribe(
      'ios-queue',
      { query: NATIVE_IOS_QUEUE_UPDATES, variables: { sessionId: SESSION } },
      TOKEN,
      (frame) => frames.push(frame),
    );
    await vi.waitFor(() => expect(frames).toHaveLength(3));
    expect(persist).not.toHaveBeenCalled();
    await bridge!.subscribe(
      'rn-join',
      { query: JOIN_SESSION, variables: { sessionId: SESSION, boardPath: PATH } },
      TOKEN,
      (frame) => frames.push(frame),
    );
    await bridge!.subscribe(
      'rn-queue',
      { query: QUEUE_UPDATES_SUBSCRIPTION, variables: { sessionId: SESSION } },
      TOKEN,
      (frame) => frames.push(frame),
    );
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
    expect(persist.mock.calls.map(([operation]) => operation.query)).toEqual([
      JOIN_SESSION,
      QUEUE_UPDATES_SUBSCRIPTION,
    ]);
    const minimalFixture: GraphqlFixtureFile = {
      formatVersion: 1,
      operationName: 'QueueUpdates',
      query: NATIVE_IOS_QUEUE_UPDATES,
      documentHash: 'native-document',
      variablesHash: 'session-variables',
      variables: { sessionId: SESSION },
      response: { data: { queueUpdates: queueSnapshot } },
      status: 200,
      recordedAt: '2026-10-12T00:00:00Z',
      upstream: origin,
    };
    expect(
      replayCampaignSessionResponse(QUEUE_UPDATES_SUBSCRIPTION, { sessionId: SESSION }, minimalFixture),
    ).toBeNull();
    for (const variables of [
      { sessionId: 'other-session', boardPath: '/kilter/1/10/1,20/0' },
      { sessionId: SESSION, boardPath: '/kilter/1/19/1,20/0' },
      { sessionId: SESSION, boardPath: '/kilter/1/10/1,20/40' },
      { sessionId: SESSION, boardPath: '/kilter/1/10/1,20/0', username: owner.profile.displayName },
    ])
      await expect(
        bridge!.subscribe('wrong-native', { query: NATIVE_CAMPAIGN_JOIN_QUERY, variables }, TOKEN, () => {}),
      ).rejects.toThrow('validation failed');
    Object.assign(owner.board, { slug: 'actual-private-board' });
    await expect(
      bridge!.subscribe(
        'wrong-native-named',
        {
          query: NATIVE_CAMPAIGN_JOIN_QUERY,
          variables: { sessionId: SESSION, boardPath: '/b/actual-private-board/40' },
        },
        TOKEN,
        () => {},
      ),
    ).rejects.toThrow('validation failed');
  });

  it('records through backend guards and permits completed/cancelled native ID reuse', async () => {
    recordingDir = mkdtempSync(join(tmpdir(), 'cpp-genuine-ws-'));
    vi.stubEnv(
      'BOARDSESH_SCREENSHOT_CAPTURE_SCENARIO',
      JSON.stringify({
        sharedSessionId: SESSION,
        boards: ['primary', 'second', 'third', 'fourth', 'fifth', 'sixth'],
        cpp: {
          target: 'kilter',
          boardReadyText: {},
          scenes: {
            search: { boardId: scope.boardUuid, readyText: 'Actual climb' },
            queue: { boardId: scope.boardUuid, readyText: 'Actual climb', sessionId: SESSION },
          },
        },
      }),
    );
    recorder = createScreenshotBackend({
      mode: 'record',
      flow: 'app-store-cpp',
      fixturesDir: recordingDir,
      upstreamUrl: origin,
      fresh: true,
      frozenNow: '2026-10-12T00:00:00Z',
      log: () => {},
    });
    const port = await recorder.listen(0, '127.0.0.1');
    const jwt = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: ACCOUNT })).toString('base64url')}.live-signature`;
    await fetch(`http://127.0.0.1:${port}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ query: GET_PROFILE }),
    });
    expect(readScreenshotFixtureManifest(recordingDir)?.accountUserId).toBe(ACCOUNT);
    const preview = await fetch(`http://127.0.0.1:${port}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ query: GET_SESSION, variables: { sessionId: SESSION } }),
    });
    expect(await preview.json()).toMatchObject({ data: { session: { id: SESSION, users: [{ id: ACCOUNT }] } } });
    const native = new WebSocket(`ws://127.0.0.1:${port}/graphql`, 'graphql-transport-ws');
    await once(native, 'open');
    const frames: Array<{ id?: string; type: string }> = [];
    native.on('message', (raw) => {
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      frames.push(JSON.parse(bytes.toString('utf8')));
    });
    native.send(JSON.stringify({ type: 'connection_init', payload: { authToken: jwt } }));
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'connection_ack')).toBe(true));
    const joinOperation = {
      query: JOIN_SESSION,
      variables: { sessionId: SESSION, boardPath: PATH, username: owner.profile.displayName, avatarUrl: null },
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const completed = frames.filter((frame) => frame.id === 'join' && frame.type === 'complete').length;
      native.send(JSON.stringify({ id: 'join', type: 'subscribe', payload: joinOperation }));
      await vi.waitFor(() =>
        expect(frames.filter((frame) => frame.id === 'join' && frame.type === 'complete')).toHaveLength(completed + 1),
      );
    }
    const queueOperation = { query: QUEUE_UPDATES_SUBSCRIPTION, variables: { sessionId: SESSION } };
    native.send(JSON.stringify({ id: 'queue', type: 'subscribe', payload: queueOperation }));
    native.send(JSON.stringify({ id: 'queue', type: 'complete' }));
    native.send(JSON.stringify({ id: 'queue', type: 'subscribe', payload: queueOperation }));
    await vi.waitFor(() => expect(frames.some((frame) => frame.id === 'queue' && frame.type === 'next')).toBe(true));
    expect(native.readyState).toBe(WebSocket.OPEN);
    const manifest = readScreenshotFixtureManifest(recordingDir)!;
    expect(manifest.graphql.filter((entry) => entry.operationName === 'JoinSession')).toHaveLength(1);
    expect(manifest.graphql.filter((entry) => entry.operationName === 'QueueUpdates')).toHaveLength(1);
    for (const file of listFixtureFiles(recordingDir))
      expect(readFileSync(join(recordingDir, file), 'utf8')).not.toContain(jwt);
    native.close();
    await once(native, 'close');
    expect(peers.size).toBe(1);
    await recorder.close();
    recorder = undefined;
    await vi.waitFor(() => expect(peers.size).toBe(0));
    async function replayResponse(query: string, variables: Record<string, unknown>) {
      const boundPort = await recorder!.listen(0, '127.0.0.1');
      const response = await fetch(`http://127.0.0.1:${boundPort}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      const body: unknown = await response.json();
      await recorder!.close();
      recorder = undefined;
      return body;
    }
    const replayOptions = {
      mode: 'replay' as const,
      fixturesDir: recordingDir,
      upstreamUrl: null,
      frozenNow: manifest.frozenNow,
      log: () => {},
    };
    recorder = createScreenshotBackend(replayOptions);
    expect(
      await replayResponse(NATIVE_CAMPAIGN_JOIN_QUERY, { sessionId: SESSION, boardPath: '/kilter/1/10/1,20/0' }),
    ).toEqual({ data: { joinSession: { id: SESSION, clientId: 'actual-client' } } });
    recorder = createScreenshotBackend(replayOptions);
    expect(await replayResponse(NATIVE_IOS_QUEUE_UPDATES, { sessionId: SESSION })).toMatchObject({
      data: {
        queueUpdates: {
          __typename: 'FullSync',
          state: { queue: [{ uuid: 'genuine-queue-item', climb: { name: 'Actual climb' } }] },
        },
      },
    });
    recorder = createScreenshotBackend(replayOptions);
    expect(await replayResponse(NATIVE_IOS_QUEUE_UPDATES, { sessionId: 'other-session' })).toHaveProperty('errors');
    const cpp = manifest.capture!.cpp!;
    for (const invalidCpp of [
      {
        ...cpp,
        scenes: {
          ...cpp.scenes,
          search: { ...cpp.scenes.search, boardId: undefined },
          queue: { ...cpp.scenes.queue, boardId: undefined },
        },
      },
      { ...cpp, scenes: { ...cpp.scenes, queue: { ...cpp.scenes.queue, boardId: 'mismatched-board' } } },
      { ...cpp, target: 'unknown-target' },
    ]) {
      writeFileSync(
        join(recordingDir, 'manifest.json'),
        JSON.stringify({ ...manifest, capture: { ...manifest.capture, cpp: invalidCpp } }),
      );
      recorder = createScreenshotBackend(replayOptions);
      expect(await replayResponse(NATIVE_IOS_QUEUE_UPDATES, { sessionId: SESSION })).toHaveProperty('errors');
    }
    writeFileSync(join(recordingDir, 'manifest.json'), JSON.stringify(manifest));
    const entry = manifest.graphql.find((item) => item.operationName === 'QueueUpdates')!;
    const filename = join(recordingDir, entry.file);
    const recorded = JSON.parse(readFileSync(filename, 'utf8')) as {
      response: { data: { queueUpdates: { state: { stateHash?: string } } } };
    };
    delete recorded.response.data.queueUpdates.state.stateHash;
    writeFileSync(filename, JSON.stringify(recorded));
    recorder = createScreenshotBackend(replayOptions);
    expect(await replayResponse(NATIVE_IOS_QUEUE_UPDATES, { sessionId: SESSION })).toHaveProperty('errors');
    const defaultManifest = { ...manifest, flow: 'app-store' };
    writeFileSync(join(recordingDir, 'manifest.json'), JSON.stringify(defaultManifest));
    recorder = createScreenshotBackend(replayOptions);
    expect(
      await replayResponse(NATIVE_CAMPAIGN_JOIN_QUERY, { sessionId: SESSION, boardPath: '/kilter/1/10/1,20/0' }),
    ).toHaveProperty('errors');
  });
});
