/**
 * Tests for the widget re-assert handler (legacy POST /api/widget/take-control).
 *
 * Sessions are always-live — there is no driver to claim. The frozen native iOS
 * widget still POSTs this endpoint, so it must keep returning 200. Repurposed to
 * RE-ASSERT the session's current climb: re-publish it via
 * `setCurrentClimbAndPublish` so a BLE phone re-sends it to the wall. With no
 * current climb, it's a successful no-op.
 *
 * Auth contract is unchanged: the bearer token must be registered to the
 * session and must have a bound userId.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import { boardSessionParticipants } from '../db/schema';

type TokenRow = { sessionId: string; userId: string | null };

type MockQueueState = {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
};

const tokenLookupRows = vi.fn<() => TokenRow[]>(() => []);
// Durable board_session_participants lookup used by the widget-session guard;
// default participant. Separate from tokenLookupRows so a test can simulate
// "token row exists but user isn't a participant".
const participantRows = vi.fn<() => Array<{ sessionId: string }>>(() => [{ sessionId: 'participant-row' }]);
// Durable session row used by the guard's ended-session check. Default active.
const getSessionByIdMock = vi.fn<() => Promise<{ status: string; endedAt: Date | null } | null>>(async () => ({
  status: 'active',
  endedAt: null,
}));
const getQueueStateMock = vi.fn<() => Promise<MockQueueState>>(async () => ({
  queue: [],
  currentClimbQueueItem: null,
}));
const setCurrentClimbAndPublishMock = vi.fn(async () => ({
  sequence: 1,
  stateHash: 'hash-1',
  queue: [] as ClimbQueueItem[],
  addedToQueue: false,
}));

vi.mock('../db/client', () => {
  function makeChain() {
    const chain: Record<string, unknown> = {};
    let table: unknown = null;
    chain.from = vi.fn((from: unknown) => {
      table = from;
      return chain;
    });
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(async (_n: number) =>
      table === boardSessionParticipants ? participantRows() : tokenLookupRows(),
    );
    return chain;
  }
  return {
    db: {
      select: vi.fn(() => makeChain()),
    },
  };
});

vi.mock('../handlers/cors', () => ({
  applyCorsHeaders: vi.fn(() => true),
}));

vi.mock('../services/room-manager', () => ({
  roomManager: {
    getQueueState: getQueueStateMock,
    getSessionById: getSessionByIdMock,
  },
}));

vi.mock('../pubsub/index', () => ({
  pubsub: {},
}));

vi.mock('../services/queue-navigation', () => ({
  setCurrentClimbAndPublish: (...args: unknown[]) => setCurrentClimbAndPublishMock(...(args as [])),
}));

const { handleWidgetTakeControl } = await import('../handlers/widget-take-control');
const { __resetWidgetRateLimitForTests } = await import('../handlers/widget-rate-limit');

const SESSION_ID = 'session-widget-test';
const USER_ID = 'user-widget-test';
const REGISTERED_TOKEN = 'b'.repeat(64);
const STRANGER_TOKEN = 'c'.repeat(64);

function makeClimbItem(): ClimbQueueItem {
  return {
    uuid: 'a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789',
    climb: {
      uuid: '22222222-2222-2222-2222-222222222222',
      setter_username: 'tester',
      name: 'V5 Test Climb',
      frames: 'p1r1,p2r2',
      angle: 40,
      ascensionist_count: 10,
      difficulty: '18',
      quality_average: '3.5',
      stars: 3,
      difficulty_error: '0.3',
      mirrored: false,
      benchmark_difficulty: null,
    },
    addedBy: 'participant-1',
    tickedBy: [],
    suggested: false,
  } as unknown as ClimbQueueItem;
}

interface MockReq extends EventEmitter {
  method?: string;
  url?: string;
  headers: Record<string, string>;
  destroy: () => void;
}

function makeRequest(opts: { method: string; body?: unknown; authHeader?: string }): MockReq {
  const emitter = new EventEmitter() as MockReq;
  emitter.method = opts.method;
  emitter.url = '/api/widget/take-control';
  emitter.headers = {};
  if (opts.authHeader) emitter.headers.authorization = opts.authHeader;
  emitter.destroy = vi.fn();

  setImmediate(() => {
    if (opts.body !== undefined) {
      emitter.emit('data', Buffer.from(JSON.stringify(opts.body), 'utf8'));
    }
    emitter.emit('end');
  });

  return emitter;
}

interface MockRes {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  writeHead: (status: number, headers?: Record<string, unknown>) => void;
  end: (body?: string) => void;
  setHeader: (name: string, value: unknown) => void;
}

function makeResponse(): MockRes {
  return {
    statusCode: 0,
    body: '',
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
    },
    end(body) {
      if (body !== undefined) this.body = body;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

describe('handleWidgetTakeControl (re-assert)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetWidgetRateLimitForTests();
    tokenLookupRows.mockReturnValue([]);
    participantRows.mockReturnValue([{ sessionId: 'participant-row' }]);
    getSessionByIdMock.mockResolvedValue({ status: 'active', endedAt: null });
    getQueueStateMock.mockResolvedValue({ queue: [], currentClimbQueueItem: null });
    setCurrentClimbAndPublishMock.mockResolvedValue({
      sequence: 1,
      stateHash: 'hash-1',
      queue: [],
      addedToQueue: false,
    });
  });

  it('returns 401 when Authorization header is missing', async () => {
    const req = makeRequest({ method: 'POST', body: { sessionId: SESSION_ID } });
    const res = makeResponse();

    await handleWidgetTakeControl(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    expect(setCurrentClimbAndPublishMock).not.toHaveBeenCalled();
  });

  it('returns 401 when bearer token is unknown', async () => {
    tokenLookupRows.mockReturnValue([]);
    const req = makeRequest({
      method: 'POST',
      authHeader: `Bearer ${STRANGER_TOKEN}`,
      body: { sessionId: SESSION_ID },
    });
    const res = makeResponse();

    await handleWidgetTakeControl(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    expect(setCurrentClimbAndPublishMock).not.toHaveBeenCalled();
  });

  it('returns 410 when bearer token is bound to a different session', async () => {
    tokenLookupRows.mockReturnValue([{ sessionId: 'session-other', userId: USER_ID }]);
    const req = makeRequest({
      method: 'POST',
      authHeader: `Bearer ${REGISTERED_TOKEN}`,
      body: { sessionId: SESSION_ID },
    });
    const res = makeResponse();

    await handleWidgetTakeControl(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(410);
    const parsed = JSON.parse(res.body) as { success: boolean; error: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('re-register');
    expect(setCurrentClimbAndPublishMock).not.toHaveBeenCalled();
  });

  it('returns 403 when registered widget token has no bound userId', async () => {
    tokenLookupRows.mockReturnValue([{ sessionId: SESSION_ID, userId: null }]);
    const req = makeRequest({
      method: 'POST',
      authHeader: `Bearer ${REGISTERED_TOKEN}`,
      body: { sessionId: SESSION_ID },
    });
    const res = makeResponse();

    await handleWidgetTakeControl(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(403);
    expect(setCurrentClimbAndPublishMock).not.toHaveBeenCalled();
  });

  it('re-asserts the current climb (publishes CurrentClimbChanged) and returns 200', async () => {
    tokenLookupRows.mockReturnValue([{ sessionId: SESSION_ID, userId: USER_ID }]);
    const current = makeClimbItem();
    getQueueStateMock.mockResolvedValue({ queue: [current], currentClimbQueueItem: current });

    const req = makeRequest({
      method: 'POST',
      authHeader: `Bearer ${REGISTERED_TOKEN}`,
      body: { sessionId: SESSION_ID },
    });
    const res = makeResponse();

    await handleWidgetTakeControl(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as { success: boolean };
    expect(parsed.success).toBe(true);
    // Re-publishes the current climb without re-adding it to the queue
    // (shouldAddToQueue=false). Pin the load-bearing args.
    expect(setCurrentClimbAndPublishMock).toHaveBeenCalledTimes(1);
    const callArgs = setCurrentClimbAndPublishMock.mock.calls[0] as unknown as [
      string,
      ClimbQueueItem,
      boolean,
      unknown,
      unknown,
      unknown,
      string,
    ];
    expect(callArgs[0]).toBe(SESSION_ID);
    expect(callArgs[1].uuid).toBe(current.uuid);
    expect(callArgs[2]).toBe(false);
    expect(callArgs[6]).toBe('widget-take-control');
  });

  it('returns 410 without re-asserting when the session has ended (stale token)', async () => {
    tokenLookupRows.mockReturnValue([{ sessionId: SESSION_ID, userId: USER_ID }]);
    const current = makeClimbItem();
    getQueueStateMock.mockResolvedValue({ queue: [current], currentClimbQueueItem: current });
    getSessionByIdMock.mockResolvedValue({ status: 'ended', endedAt: new Date('2026-01-01T00:00:00Z') });

    const req = makeRequest({
      method: 'POST',
      authHeader: `Bearer ${REGISTERED_TOKEN}`,
      body: { sessionId: SESSION_ID },
    });
    const res = makeResponse();
    await handleWidgetTakeControl(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(410);
    expect(setCurrentClimbAndPublishMock).not.toHaveBeenCalled();
  });

  it('returns 403 without re-asserting when the token user is not a participant', async () => {
    tokenLookupRows.mockReturnValue([{ sessionId: SESSION_ID, userId: USER_ID }]);
    const current = makeClimbItem();
    getQueueStateMock.mockResolvedValue({ queue: [current], currentClimbQueueItem: current });
    participantRows.mockReturnValue([]); // token row exists, but no participant record

    const req = makeRequest({
      method: 'POST',
      authHeader: `Bearer ${REGISTERED_TOKEN}`,
      body: { sessionId: SESSION_ID },
    });
    const res = makeResponse();
    await handleWidgetTakeControl(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(403);
    expect(setCurrentClimbAndPublishMock).not.toHaveBeenCalled();
  });

  it('succeeds without re-publishing when there is no current climb', async () => {
    tokenLookupRows.mockReturnValue([{ sessionId: SESSION_ID, userId: USER_ID }]);
    getQueueStateMock.mockResolvedValue({ queue: [], currentClimbQueueItem: null });

    const req = makeRequest({
      method: 'POST',
      authHeader: `Bearer ${REGISTERED_TOKEN}`,
      body: { sessionId: SESSION_ID },
    });
    const res = makeResponse();

    await handleWidgetTakeControl(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as { success: boolean };
    expect(parsed.success).toBe(true);
    expect(setCurrentClimbAndPublishMock).not.toHaveBeenCalled();
  });

  it('rate-limits rapid re-assert mashing per session (429) after the bucket drains', async () => {
    // The re-assert calls setCurrentClimbAndPublish (optimistic-lock retry loop
    // + BLE re-send), so lock-screen lightbulb mashing must be bounded. Shared
    // per-session token bucket: capacity 2, so the 3rd rapid tap is rejected.
    tokenLookupRows.mockReturnValue([{ sessionId: SESSION_ID, userId: USER_ID }]);
    const current = makeClimbItem();
    getQueueStateMock.mockResolvedValue({ queue: [current], currentClimbQueueItem: current });

    async function tap(): Promise<number> {
      const req = makeRequest({
        method: 'POST',
        authHeader: `Bearer ${REGISTERED_TOKEN}`,
        body: { sessionId: SESSION_ID },
      });
      const res = makeResponse();
      await handleWidgetTakeControl(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      return res.statusCode;
    }

    expect(await tap()).toBe(200);
    expect(await tap()).toBe(200);
    // Third rapid tap drains the bucket -> 429, and no extra board write fires.
    const third = await tap();
    expect(third).toBe(429);
    expect(setCurrentClimbAndPublishMock).toHaveBeenCalledTimes(2);
  });

  it('returns 500 without leaking details when the re-assert fails', async () => {
    tokenLookupRows.mockReturnValue([{ sessionId: SESSION_ID, userId: USER_ID }]);
    const current = makeClimbItem();
    getQueueStateMock.mockResolvedValue({ queue: [current], currentClimbQueueItem: current });
    setCurrentClimbAndPublishMock.mockRejectedValueOnce(new Error('redis exploded'));
    const req = makeRequest({
      method: 'POST',
      authHeader: `Bearer ${REGISTERED_TOKEN}`,
      body: { sessionId: SESSION_ID },
    });
    const res = makeResponse();

    await handleWidgetTakeControl(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(res.statusCode).toBe(500);
    const parsed = JSON.parse(res.body) as { success: boolean; error: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Internal server error');
  });

  it('returns 400 for malformed bodies and 405 for non-POST methods', async () => {
    const badBodyReq = makeRequest({
      method: 'POST',
      authHeader: `Bearer ${REGISTERED_TOKEN}`,
      body: { sessionId: '' },
    });
    const badBodyRes = makeResponse();
    await handleWidgetTakeControl(badBodyReq as unknown as IncomingMessage, badBodyRes as unknown as ServerResponse);
    expect(badBodyRes.statusCode).toBe(400);

    const getReq = makeRequest({ method: 'GET' });
    const getRes = makeResponse();
    await handleWidgetTakeControl(getReq as unknown as IncomingMessage, getRes as unknown as ServerResponse);
    expect(getRes.statusCode).toBe(405);
  });
});
