/**
 * Tests for GET /api/session/state — the slim, poll-friendly session snapshot
 * the Garmin watch reads (it can't hold a WebSocket subscription). Verifies the
 * auth + guard gating and that the payload carries exactly the render + saveTick
 * fields, with board resolution parsed from the session's boardPath.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

const validateTokenMock = vi.fn<(token: string) => Promise<{ userId: string; isAuthenticated: true } | null>>(
  async () => ({ userId: USER_ID, isAuthenticated: true }),
);
// The guard now returns the loaded session row on the ok path so the handler
// reads boardPath without a second getSessionById round-trip.
type SessionRow = { boardPath: string; status: string; endedAt: Date | null };
const SESSION_ROW: SessionRow = { boardPath: 'kilter/8/17/20,21/40', status: 'active', endedAt: null };
type GuardResult = { ok: true; session: SessionRow } | { ok: false; status: 410 | 403; error: string };
const verifyWidgetSessionMock = vi.fn<() => Promise<GuardResult>>(async () => ({ ok: true, session: SESSION_ROW }));

type MockClimb = {
  uuid: string;
  name: string;
  difficulty: string;
  angle: number;
  mirrored: boolean | null;
  benchmark_difficulty: string | null;
};
type MockQueueItem = { uuid: string; climb: MockClimb };
type MockQueueState = {
  queue: MockQueueItem[];
  currentClimbQueueItem: MockQueueItem | null;
  sequence: number;
  stateHash: string;
};
const getQueueStateMock = vi.fn<() => Promise<MockQueueState>>(async () => makeQueueState());
type ResolvedNamedBoard = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};
const resolveBoardBySlugMock = vi.fn<(slug: string) => Promise<ResolvedNamedBoard | null>>(async () => null);

vi.mock('../graphql/resolvers/shared/board-lookup', () => ({
  resolveBoardBySlug: resolveBoardBySlugMock,
}));

vi.mock('../handlers/cors', () => ({
  applyCorsHeaders: vi.fn(() => true),
}));

vi.mock('../middleware/auth', () => ({
  validateToken: (token: string) => validateTokenMock(token),
}));

vi.mock('../handlers/widget-session-guard', () => ({
  verifyWidgetSession: () => verifyWidgetSessionMock(),
}));

vi.mock('../services/room-manager', () => ({
  roomManager: {
    getQueueState: getQueueStateMock,
  },
}));

const { handleSessionState } = await import('../handlers/session-state');
const { __resetSessionUserRateLimitForTests } = await import('../handlers/session-user-rate-limit');

const SESSION_ID = 'session-state-test';
const USER_ID = 'user-state-test';
const bearer = 'Bearer a.b.c';

function makeClimb(overrides: Partial<MockClimb> = {}): MockClimb {
  return {
    uuid: 'climb-uuid-2',
    name: 'Zombie Slayer',
    difficulty: 'V5',
    angle: 40,
    mirrored: false,
    benchmark_difficulty: 'V5',
    ...overrides,
  };
}

function makeQueueState(): MockQueueState {
  const q2 = { uuid: 'q2', climb: makeClimb() };
  return {
    queue: [{ uuid: 'q1', climb: makeClimb({ uuid: 'climb-uuid-1', name: 'Warmup' }) }, q2],
    currentClimbQueueItem: q2,
    sequence: 42,
    stateHash: 'hash-42',
  };
}

interface MockReq extends EventEmitter {
  method?: string;
  headers: Record<string, string>;
}

function makeRequest(opts: { method: string; authHeader?: string }): MockReq {
  const emitter = new EventEmitter() as MockReq;
  emitter.method = opts.method;
  emitter.headers = {};
  if (opts.authHeader) emitter.headers.authorization = opts.authHeader;
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

async function run(opts: { method: string; authHeader?: string; sessionId?: string }): Promise<MockRes> {
  const req = makeRequest(opts);
  const res = makeResponse();
  const query = opts.sessionId !== undefined ? `?sessionId=${opts.sessionId}` : '';
  const url = new URL(`http://localhost/api/session/state${query}`);
  await handleSessionState(req as unknown as IncomingMessage, res as unknown as ServerResponse, url);
  return res;
}

describe('handleSessionState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSessionUserRateLimitForTests();
    validateTokenMock.mockResolvedValue({ userId: USER_ID, isAuthenticated: true });
    verifyWidgetSessionMock.mockResolvedValue({ ok: true, session: SESSION_ROW });
    getQueueStateMock.mockResolvedValue(makeQueueState());
    resolveBoardBySlugMock.mockReset().mockResolvedValue(null);
  });

  it('returns 405 for non-GET methods', async () => {
    const res = await run({ method: 'POST', authHeader: bearer, sessionId: SESSION_ID });
    expect(res.statusCode).toBe(405);
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const res = await run({ method: 'GET', sessionId: SESSION_ID });
    expect(res.statusCode).toBe(401);
    expect(resolveBoardBySlugMock).not.toHaveBeenCalled();
  });

  it('returns 401 when the token is invalid', async () => {
    validateTokenMock.mockResolvedValue(null);
    const res = await run({ method: 'GET', authHeader: bearer, sessionId: SESSION_ID });
    expect(res.statusCode).toBe(401);
    expect(resolveBoardBySlugMock).not.toHaveBeenCalled();
  });

  it('returns 400 when sessionId is missing', async () => {
    const res = await run({ method: 'GET', authHeader: bearer });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 when the guard reports not-a-participant', async () => {
    verifyWidgetSessionMock.mockResolvedValue({ ok: false, status: 403, error: 'Not a participant in this session' });
    const res = await run({ method: 'GET', authHeader: bearer, sessionId: SESSION_ID });
    expect(res.statusCode).toBe(403);
    expect(resolveBoardBySlugMock).not.toHaveBeenCalled();
  });

  it('returns the slim current-climb payload with board resolution from boardPath', async () => {
    const res = await run({ method: 'GET', authHeader: bearer, sessionId: SESSION_ID });
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed).toMatchObject({
      sessionId: SESSION_ID,
      sequence: 42,
      stateHash: 'hash-42',
      currentIndex: 1,
      queueLength: 2,
      boardType: 'kilter',
      layoutId: 8,
      sizeId: 17,
      setIds: '20,21',
      angle: 40,
      climb: {
        climbUuid: 'climb-uuid-2',
        name: 'Zombie Slayer',
        difficulty: 'V5',
        angle: 40,
        mirrored: false,
        isBenchmark: true,
      },
    });
    // The heavy queue array / frames must never be serialized to the watch.
    expect(res.body).not.toContain('frames');
    expect(res.body).not.toContain('"queue"');
    expect(resolveBoardBySlugMock).not.toHaveBeenCalled();
  });

  it.each([
    ['/b/marcos-garage/25', 25, 'marcos-garage'],
    ['/b/marcos-garage/0', 0, 'marcos-garage'],
    ['/b/marcos-garage', 40, 'marcos-garage'],
    ['/es/b/marcos-garage/30/list', 30, 'marcos-garage'],
    ['/b/123/30/list', 30, '123'],
  ] as const)('resolves named path %s for watch tick logging at %s degrees', async (boardPath, angle, slug) => {
    verifyWidgetSessionMock.mockResolvedValue({
      ok: true,
      session: { boardPath, status: 'active', endedAt: null },
    });
    resolveBoardBySlugMock.mockResolvedValue({
      boardType: 'kilter',
      layoutId: 8,
      sizeId: 17,
      setIds: '20,21',
      angle: 40,
    });

    const res = await run({ method: 'GET', authHeader: bearer, sessionId: SESSION_ID });

    expect(res.statusCode).toBe(200);
    expect(resolveBoardBySlugMock).toHaveBeenCalledWith(slug);
    expect(JSON.parse(res.body)).toMatchObject({
      boardType: 'kilter',
      layoutId: 8,
      sizeId: 17,
      setIds: '20,21',
      angle,
    });
  });

  it('returns null board metadata when a named board no longer resolves', async () => {
    verifyWidgetSessionMock.mockResolvedValue({
      ok: true,
      session: { boardPath: '/b/deleted-board/25', status: 'active', endedAt: null },
    });

    const res = await run({ method: 'GET', authHeader: bearer, sessionId: SESSION_ID });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      boardType: null,
      layoutId: null,
      sizeId: null,
      setIds: null,
      angle: null,
    });
  });

  it('returns 500 without exposing a named-board lookup error', async () => {
    verifyWidgetSessionMock.mockResolvedValue({
      ok: true,
      session: { boardPath: '/b/marcos-garage/25', status: 'active', endedAt: null },
    });
    resolveBoardBySlugMock.mockRejectedValue(new Error('database connection failed'));

    const res = await run({ method: 'GET', authHeader: bearer, sessionId: SESSION_ID });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Internal server error' });
  });

  it('reports climb: null and currentIndex -1 when there is no current climb', async () => {
    getQueueStateMock.mockResolvedValue({
      queue: [{ uuid: 'q1', climb: makeClimb() }],
      currentClimbQueueItem: null,
      sequence: 7,
      stateHash: 'hash-7',
    });
    const res = await run({ method: 'GET', authHeader: bearer, sessionId: SESSION_ID });
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as { climb: unknown; currentIndex: number; queueLength: number };
    expect(parsed.climb).toBeNull();
    expect(parsed.currentIndex).toBe(-1);
    expect(parsed.queueLength).toBe(1);
  });

  it('reports isBenchmark false for a non-benchmark climb', async () => {
    const nonBenchmark = { uuid: 'q1', climb: makeClimb({ benchmark_difficulty: null }) };
    getQueueStateMock.mockResolvedValue({
      queue: [nonBenchmark],
      currentClimbQueueItem: nonBenchmark,
      sequence: 3,
      stateHash: 'hash-3',
    });
    const res = await run({ method: 'GET', authHeader: bearer, sessionId: SESSION_ID });
    const parsed = JSON.parse(res.body) as { climb: { isBenchmark: boolean } };
    expect(parsed.climb.isBenchmark).toBe(false);
  });

  it('treats an empty-string benchmark_difficulty as not a benchmark', async () => {
    const emptyBenchmark = { uuid: 'q1', climb: makeClimb({ benchmark_difficulty: '' }) };
    getQueueStateMock.mockResolvedValue({
      queue: [emptyBenchmark],
      currentClimbQueueItem: emptyBenchmark,
      sequence: 3,
      stateHash: 'hash-3',
    });
    const res = await run({ method: 'GET', authHeader: bearer, sessionId: SESSION_ID });
    const parsed = JSON.parse(res.body) as { climb: { isBenchmark: boolean } };
    expect(parsed.climb.isBenchmark).toBe(false);
  });

  it('returns null board fields when the session boardPath is malformed', async () => {
    verifyWidgetSessionMock.mockResolvedValue({
      ok: true,
      session: { boardPath: 'not-a-board-path', status: 'active', endedAt: null },
    });
    const res = await run({ method: 'GET', authHeader: bearer, sessionId: SESSION_ID });
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as {
      boardType: unknown;
      layoutId: unknown;
      sizeId: unknown;
      setIds: unknown;
      angle: unknown;
    };
    expect(parsed.boardType).toBeNull();
    expect(parsed.layoutId).toBeNull();
    expect(parsed.sizeId).toBeNull();
    expect(parsed.setIds).toBeNull();
    expect(parsed.angle).toBeNull();
  });

  it('passes through the guard 410 when the session has ended', async () => {
    verifyWidgetSessionMock.mockResolvedValue({ ok: false, status: 410, error: 'Session has ended; re-register' });
    const res = await run({ method: 'GET', authHeader: bearer, sessionId: SESSION_ID });
    expect(res.statusCode).toBe(410);
    expect(resolveBoardBySlugMock).not.toHaveBeenCalled();
  });

  it('returns 500 without leaking details when the queue read throws', async () => {
    getQueueStateMock.mockRejectedValue(new Error('redis exploded'));
    const res = await run({ method: 'GET', authHeader: bearer, sessionId: SESSION_ID });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Internal server error' });
  });

  it('rate-limits a hammering poller (429) once the per-user read bucket drains', async () => {
    // Read bucket capacity is 4; a 5th rapid poll from the same user is throttled.
    for (let i = 0; i < 4; i++) {
      expect((await run({ method: 'GET', authHeader: bearer, sessionId: SESSION_ID })).statusCode).toBe(200);
    }
    const throttled = await run({ method: 'GET', authHeader: bearer, sessionId: SESSION_ID });
    expect(throttled.statusCode).toBe(429);
  });
});
