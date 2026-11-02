/**
 * Tests for the JWT-authed session control handlers used by the Garmin watch:
 * POST /api/session/navigate and POST /api/session/take-control.
 *
 * These mirror the iOS widget's navigate/take-control but authenticate with a
 * mobile JWT (validateToken) instead of a registered APNs push token. The
 * server-authoritative queue math lives in session-queue-actions (mocked here);
 * these tests cover the handler contract: auth, rate limit, the durable-session
 * guard passthrough, and outcome → HTTP mapping.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Mocks (hoisted before importing the handlers)
// ---------------------------------------------------------------------------

const validateTokenMock = vi.fn<(token: string) => Promise<{ userId: string; isAuthenticated: true } | null>>(
  async () => ({ userId: USER_ID, isAuthenticated: true }),
);
type GuardResult = { ok: true } | { ok: false; status: 410 | 403; error: string };
const verifyWidgetSessionMock = vi.fn<() => Promise<GuardResult>>(async () => ({ ok: true }));
type NavigateOutcome =
  | { kind: 'ok'; currentIndex: number; queueLength: number; serverCurrentIndex: number; targetIndex: number }
  | { kind: 'queue_empty' }
  | { kind: 'out_of_bounds'; queueLength: number; serverCurrentIndex: number; targetIndex: number };
const navigateSessionQueueMock = vi.fn<
  (sessionId: string, action: string, correlationId: string, moverUserId: string | null) => Promise<NavigateOutcome>
>(async () => ({
  kind: 'ok',
  currentIndex: 1,
  queueLength: 2,
  serverCurrentIndex: 0,
  targetIndex: 1,
}));
const reassertSessionCurrentClimbMock = vi.fn<() => Promise<void>>(async () => undefined);

vi.mock('../handlers/cors', () => ({
  applyCorsHeaders: vi.fn(() => true),
}));

vi.mock('../middleware/auth', () => ({
  validateToken: (token: string) => validateTokenMock(token),
}));

vi.mock('../handlers/widget-session-guard', () => ({
  verifyWidgetSession: () => verifyWidgetSessionMock(),
}));

vi.mock('../handlers/session-queue-actions', () => ({
  navigateSessionQueue: (sessionId: string, action: string, correlationId: string, moverUserId: string | null) =>
    navigateSessionQueueMock(sessionId, action, correlationId, moverUserId),
  reassertSessionCurrentClimb: () => reassertSessionCurrentClimbMock(),
}));

const { handleSessionNavigate, handleSessionTakeControl } = await import('../handlers/session-actions');
const { __resetWidgetRateLimitForTests } = await import('../handlers/widget-rate-limit');
const { __resetSessionUserRateLimitForTests } = await import('../handlers/session-user-rate-limit');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-watch-test';
const USER_ID = 'user-watch-test';
const JWT = 'a.b.c'; // shape is irrelevant — validateToken is mocked

interface MockReq extends EventEmitter {
  method?: string;
  url?: string;
  headers: Record<string, string>;
  destroy: () => void;
}

function makeRequest(opts: { method: string; body?: unknown; authHeader?: string }): MockReq {
  const emitter = new EventEmitter() as MockReq;
  emitter.method = opts.method;
  emitter.url = '/api/session/navigate';
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

async function runNavigate(opts: { method: string; body?: unknown; authHeader?: string }): Promise<MockRes> {
  const req = makeRequest(opts);
  const res = makeResponse();
  await handleSessionNavigate(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res;
}

async function runTakeControl(opts: { method: string; body?: unknown; authHeader?: string }): Promise<MockRes> {
  const req = makeRequest(opts);
  const res = makeResponse();
  await handleSessionTakeControl(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res;
}

const bearer = `Bearer ${JWT}`;
const navBody = { sessionId: SESSION_ID, action: 'next' as const };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleSessionNavigate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetWidgetRateLimitForTests();
    __resetSessionUserRateLimitForTests();
    validateTokenMock.mockResolvedValue({ userId: USER_ID, isAuthenticated: true });
    verifyWidgetSessionMock.mockResolvedValue({ ok: true });
    navigateSessionQueueMock.mockResolvedValue({
      kind: 'ok',
      currentIndex: 1,
      queueLength: 2,
      serverCurrentIndex: 0,
      targetIndex: 1,
    });
  });

  it('returns 405 for non-POST methods', async () => {
    const res = await runNavigate({ method: 'GET' });
    expect(res.statusCode).toBe(405);
  });

  it('returns 400 for a missing/invalid action', async () => {
    const res = await runNavigate({ method: 'POST', authHeader: bearer, body: { sessionId: SESSION_ID } });
    expect(res.statusCode).toBe(400);
    expect(navigateSessionQueueMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty sessionId', async () => {
    const res = await runNavigate({ method: 'POST', authHeader: bearer, body: { sessionId: '', action: 'next' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const res = await runNavigate({ method: 'POST', body: navBody });
    expect(res.statusCode).toBe(401);
    expect(navigateSessionQueueMock).not.toHaveBeenCalled();
  });

  it('returns 401 when the token is invalid', async () => {
    validateTokenMock.mockResolvedValue(null);
    const res = await runNavigate({ method: 'POST', authHeader: bearer, body: navBody });
    expect(res.statusCode).toBe(401);
    expect(navigateSessionQueueMock).not.toHaveBeenCalled();
  });

  it('returns 410 without navigating when the guard reports the session ended', async () => {
    verifyWidgetSessionMock.mockResolvedValue({ ok: false, status: 410, error: 'Session has ended; re-register' });
    const res = await runNavigate({ method: 'POST', authHeader: bearer, body: navBody });
    expect(res.statusCode).toBe(410);
    expect(navigateSessionQueueMock).not.toHaveBeenCalled();
  });

  it('returns 403 without navigating when the guard reports not-a-participant', async () => {
    verifyWidgetSessionMock.mockResolvedValue({ ok: false, status: 403, error: 'Not a participant in this session' });
    const res = await runNavigate({ method: 'POST', authHeader: bearer, body: navBody });
    expect(res.statusCode).toBe(403);
    expect(navigateSessionQueueMock).not.toHaveBeenCalled();
  });

  it('returns 200 with the new currentIndex on success', async () => {
    const res = await runNavigate({ method: 'POST', authHeader: bearer, body: navBody });
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as { success: boolean; currentIndex: number };
    expect(parsed.success).toBe(true);
    expect(parsed.currentIndex).toBe(1);
    expect(navigateSessionQueueMock).toHaveBeenCalledOnce();
  });

  // The watch's step is its own climber's: the event names that account as the
  // mover, so their phone never reads it as a crewmate's put-up (2.7 window).
  it("names the watch's account as the mover", async () => {
    await runNavigate({ method: 'POST', authHeader: bearer, body: navBody });
    expect(navigateSessionQueueMock).toHaveBeenCalledExactlyOnceWith(SESSION_ID, 'next', 'session-navigate', USER_ID);
  });

  it('returns 409 when the queue is empty', async () => {
    navigateSessionQueueMock.mockResolvedValue({ kind: 'queue_empty' });
    const res = await runNavigate({ method: 'POST', authHeader: bearer, body: navBody });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ success: false, error: 'Queue is empty' });
  });

  it('returns 409 when the target index is out of bounds', async () => {
    navigateSessionQueueMock.mockResolvedValue({
      kind: 'out_of_bounds',
      queueLength: 2,
      serverCurrentIndex: 0,
      targetIndex: 5,
    });
    const res = await runNavigate({ method: 'POST', authHeader: bearer, body: navBody });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ success: false, error: 'Target index out of bounds' });
  });

  it('returns 500 without leaking details when navigation throws', async () => {
    navigateSessionQueueMock.mockRejectedValue(new Error('redis exploded'));
    const res = await runNavigate({ method: 'POST', authHeader: bearer, body: navBody });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toMatchObject({ success: false, error: 'Internal server error' });
  });

  it('returns 429 once the per-session bucket drains (capacity 2)', async () => {
    expect((await runNavigate({ method: 'POST', authHeader: bearer, body: navBody })).statusCode).toBe(200);
    expect((await runNavigate({ method: 'POST', authHeader: bearer, body: navBody })).statusCode).toBe(200);
    const third = await runNavigate({ method: 'POST', authHeader: bearer, body: navBody });
    expect(third.statusCode).toBe(429);
  });

  it('does not let a non-participant drain the per-session write bucket (no poisoning)', async () => {
    // Attacker: a valid JWT for a DIFFERENT user who isn't a participant. The
    // guard 403s them, so they never reach the per-session (widget) write bucket;
    // their own per-user bucket absorbs the spam.
    validateTokenMock.mockResolvedValue({ userId: 'attacker', isAuthenticated: true });
    verifyWidgetSessionMock.mockResolvedValue({ ok: false, status: 403, error: 'Not a participant in this session' });
    for (let i = 0; i < 3; i++) {
      expect((await runNavigate({ method: 'POST', authHeader: bearer, body: navBody })).statusCode).toBe(403);
    }
    // A genuine participant (a different user, fresh per-user bucket) still gets
    // the full capacity-2 of navigations — the session's write bucket was never
    // touched.
    validateTokenMock.mockResolvedValue({ userId: 'victim', isAuthenticated: true });
    verifyWidgetSessionMock.mockResolvedValue({ ok: true });
    expect((await runNavigate({ method: 'POST', authHeader: bearer, body: navBody })).statusCode).toBe(200);
    expect((await runNavigate({ method: 'POST', authHeader: bearer, body: navBody })).statusCode).toBe(200);
  });

  it('throttles a hammering non-participant via the per-user bucket (bounds guard DB load)', async () => {
    // A non-participant 403s at the guard on every request, never reaching the
    // per-session bucket — so the per-user bucket (capacity 4) is what bounds the
    // guard's DB queries. The 5th rapid request is throttled before the guard.
    verifyWidgetSessionMock.mockResolvedValue({ ok: false, status: 403, error: 'Not a participant in this session' });
    for (let i = 0; i < 4; i++) {
      expect((await runNavigate({ method: 'POST', authHeader: bearer, body: navBody })).statusCode).toBe(403);
    }
    expect((await runNavigate({ method: 'POST', authHeader: bearer, body: navBody })).statusCode).toBe(429);
  });
});

describe('handleSessionTakeControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetWidgetRateLimitForTests();
    __resetSessionUserRateLimitForTests();
    validateTokenMock.mockResolvedValue({ userId: USER_ID, isAuthenticated: true });
    verifyWidgetSessionMock.mockResolvedValue({ ok: true });
    reassertSessionCurrentClimbMock.mockResolvedValue(undefined);
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const res = await runTakeControl({ method: 'POST', body: { sessionId: SESSION_ID } });
    expect(res.statusCode).toBe(401);
    expect(reassertSessionCurrentClimbMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty sessionId', async () => {
    const res = await runTakeControl({ method: 'POST', authHeader: bearer, body: { sessionId: '' } });
    expect(res.statusCode).toBe(400);
  });

  it('re-asserts the current climb and returns 200', async () => {
    const res = await runTakeControl({ method: 'POST', authHeader: bearer, body: { sessionId: SESSION_ID } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ success: true });
    expect(reassertSessionCurrentClimbMock).toHaveBeenCalledOnce();
  });

  it('returns 410 without re-asserting when the guard reports the session ended', async () => {
    verifyWidgetSessionMock.mockResolvedValue({ ok: false, status: 410, error: 'Session has ended; re-register' });
    const res = await runTakeControl({ method: 'POST', authHeader: bearer, body: { sessionId: SESSION_ID } });
    expect(res.statusCode).toBe(410);
    expect(reassertSessionCurrentClimbMock).not.toHaveBeenCalled();
  });

  it('returns 500 without leaking details when re-assert throws', async () => {
    reassertSessionCurrentClimbMock.mockRejectedValue(new Error('boom'));
    const res = await runTakeControl({ method: 'POST', authHeader: bearer, body: { sessionId: SESSION_ID } });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toMatchObject({ success: false, error: 'Internal server error' });
  });
});
