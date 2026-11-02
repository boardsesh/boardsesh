import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  guard: vi.fn(),
  limit: vi.fn(),
  mirror: vi.fn(),
  boardBySlug: vi.fn(),
  boundBoard: vi.fn(),
}));
vi.mock('../db/client', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.boundBoard }) }) }) },
}));
vi.mock('../graphql/resolvers/shared/board-lookup', () => ({ resolveBoardBySlug: mocks.boardBySlug }));
vi.mock('../handlers/widget-auth', () => ({ authenticateWidget: mocks.auth }));
vi.mock('../handlers/widget-session-guard', () => ({ verifyWidgetSession: mocks.guard }));
vi.mock('../handlers/widget-rate-limit', () => ({
  checkWidgetRateLimit: mocks.limit,
  ensureWidgetRateLimitPruner: vi.fn(),
}));
vi.mock('../handlers/cors', () => ({ applyCorsHeaders: () => true }));
vi.mock('../services/queue-mirror', () => ({
  mirrorSessionClimb: mocks.mirror,
  MirrorTargetChangedError: class extends Error {},
}));
import { handleWidgetMirror } from '../handlers/widget-mirror';

async function request(body: unknown) {
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  req.method = 'POST';
  req.headers = { authorization: 'Bearer registered' };
  const response = { writeHead: vi.fn(), end: vi.fn() };
  await handleWidgetMirror(req, response as unknown as ServerResponse);
  return {
    status: response.writeHead.mock.calls[0][0],
    body: JSON.parse(response.end.mock.calls[0][0] as string) as Record<string, unknown>,
  };
}
const body = { sessionId: 'session', queueItemUuid: 'slot', mirrored: true };
describe('widget mirror endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ kind: 'ok', userId: 'user' });
    mocks.guard.mockResolvedValue({ ok: true, session: { boardPath: 'tension/1/1/1/40' } });
    mocks.limit.mockReturnValue(true);
    mocks.mirror.mockResolvedValue({
      item: { uuid: 'slot' },
      event: { sequence: 8, mirrored: true, stateHash: 'hash' },
    });
  });
  it('returns a sequenced confirmation for the exact requested slot', async () => {
    const response = await request(body);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ sessionId: 'session', queueItemUuid: 'slot', mirrored: true, sequence: 8 });
    expect(mocks.mirror).toHaveBeenCalledWith('session', true, 'slot');
  });
  it.each([
    ['unknown token', { kind: 'unknown' }, 401],
    ['wrong session', { kind: 'wrong-session' }, 410],
    ['anonymous token', { kind: 'ok', userId: null }, 403],
  ])('rejects %s before mutation', async (_name, auth, status) => {
    mocks.auth.mockResolvedValue(auth);
    expect((await request(body)).status).toBe(status);
    expect(mocks.mirror).not.toHaveBeenCalled();
  });
  it('rejects ended sessions and unsupported boards', async () => {
    mocks.guard.mockResolvedValueOnce({ ok: false, status: 410, error: 'Ended' });
    expect((await request(body)).status).toBe(410);
    mocks.guard.mockResolvedValueOnce({ ok: true, session: { boardPath: 'tension/11/1/1/40' } });
    expect((await request(body)).status).toBe(409);
    expect(mocks.mirror).not.toHaveBeenCalled();
  });
  it('mirrors on a named wall by looking its layout up, and refuses one that does not mirror', async () => {
    // A gym wall, or a home wall whose session carries its name (#7013).
    mocks.guard.mockResolvedValue({ ok: true, session: { boardPath: '/b/marcos-garage/40' } });
    mocks.boardBySlug.mockResolvedValueOnce({ boardType: 'tension', layoutId: 1 });
    expect((await request(body)).status).toBe(200);
    expect(mocks.boardBySlug).toHaveBeenCalledWith('marcos-garage');
    expect(mocks.mirror).toHaveBeenCalledWith('session', true, 'slot');

    mocks.mirror.mockClear();
    mocks.boardBySlug.mockResolvedValueOnce({ boardType: 'tension', layoutId: 11 });
    expect((await request(body)).status).toBe(409);
    mocks.boardBySlug.mockResolvedValueOnce(null);
    expect((await request(body)).status).toBe(409);
    expect(mocks.mirror).not.toHaveBeenCalled();
  });
  it("reads a named session's own bound board before the slug, which can be reused", async () => {
    // The slug now belongs to somebody else's Kilter; the session is on a Tension.
    mocks.guard.mockResolvedValue({ ok: true, session: { boardPath: '/b/reused-slug/40', boardId: 42 } });
    mocks.boundBoard.mockResolvedValueOnce([{ boardType: 'tension', layoutId: 1 }]);
    mocks.boardBySlug.mockResolvedValue({ boardType: 'kilter', layoutId: 1 });
    expect((await request(body)).status).toBe(200);
    expect(mocks.boardBySlug).not.toHaveBeenCalled();
  });
  it('rejects malformed or rate-limited requests', async () => {
    expect((await request({ ...body, mirrored: 'true' })).status).toBe(400);
    mocks.limit.mockReturnValue(false);
    expect((await request(body)).status).toBe(429);
    expect(mocks.mirror).not.toHaveBeenCalled();
  });
});
