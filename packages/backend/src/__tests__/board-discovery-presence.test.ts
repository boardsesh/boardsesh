import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { BoardPresenceStore } from '../pubsub/board-presence-store';
import { redisClientManager } from '../redis/client';

const evaluate = vi.fn();
const store = new BoardPresenceStore({
  isRedisAvailable: () => true,
  isRedisRequired: () => true,
  logger: { error: vi.fn(), warn: vi.fn() },
});
const climb = {
  climbUuid: 'climb-one',
  name: 'Confirmed climb',
  frames: 'p1r12',
  angle: 40,
  seq: 10,
  sentByUserId: 'holder-one',
  sentByDisplayName: 'Private identity',
  sentAt: '2026-09-19T00:00:00Z',
};
const snapshot = (overrides: Record<string, unknown> = {}, writer = 'holder-one') => [
  writer,
  [JSON.stringify({ ...climb, ...overrides })],
];

beforeEach(() => {
  evaluate.mockReset();
  vi.spyOn(redisClientManager, 'getClients').mockReturnValue({
    publisher: { eval: evaluate },
  } as unknown as ReturnType<typeof redisClientManager.getClients>);
});
afterEach(() => vi.restoreAllMocks());

describe('board discovery presence snapshot', () => {
  it('reads real Redis atomically and stops showing a climb after release despite retained history', async () => {
    const publisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6380', { maxRetriesPerRequest: 1 });
    const boardId = `discovery-test-${uuidv4()}`;
    const writerKey = `board:${boardId}:writer`;
    const historyKey = `board:${boardId}:history`;
    vi.spyOn(redisClientManager, 'getClients').mockReturnValue({ publisher } as unknown as ReturnType<
      typeof redisClientManager.getClients
    >);
    try {
      await publisher.set(writerKey, 'holder-one', 'EX', 60);
      await publisher.lpush(historyKey, JSON.stringify(climb));
      await publisher.expire(historyKey, 60);
      expect(await store.getBoardDiscoveryClimb(boardId)).toEqual({
        uuid: 'climb-one',
        name: 'Confirmed climb',
        frames: 'p1r12',
        angle: 40,
      });
      await publisher.del(writerKey);
      expect(await publisher.llen(historyKey)).toBe(1);
      expect(await store.getBoardDiscoveryClimb(boardId)).toBeNull();
    } finally {
      await publisher.del(writerKey, historyKey);
      await publisher.quit();
    }
  });

  it('atomically reads a bounded snapshot and strips sender identity', async () => {
    evaluate.mockResolvedValue(snapshot());
    expect(await store.getBoardDiscoveryClimb('42')).toEqual({
      uuid: 'climb-one',
      name: 'Confirmed climb',
      frames: 'p1r12',
      angle: 40,
    });
    expect(evaluate).toHaveBeenCalledWith(
      expect.stringContaining("'lrange', KEYS[2], 0, 49"),
      2,
      'board:42:writer',
      'board:42:history',
    );
  });

  it.each([
    ['cleared or expired writer', []],
    ['writer without history', ['holder-one', []]],
    ['different writer', snapshot({}, 'holder-two')],
    ['anonymous writer', snapshot({ sentByUserId: null }, 'conn:anonymous')],
    ['imported history', snapshot({ source: 'kilter' })],
    ['missing frames', snapshot({ frames: null })],
    ['missing angle', snapshot({ angle: null })],
    ['invalid angle', snapshot({ angle: 40.5 })],
    ['missing climb identity', snapshot({ climbUuid: '' })],
    ['malformed history', ['holder-one', ['not-json']]],
    ['invalid sequence', snapshot({ seq: '10' })],
  ])('returns no lit preview for %s', async (_name, redisSnapshot) => {
    evaluate.mockResolvedValue(redisSnapshot);
    expect(await store.getBoardDiscoveryClimb('42')).toBeNull();
  });

  it('selects newest sequence rather than arrival order', async () => {
    evaluate.mockResolvedValue([
      'holder-one',
      [JSON.stringify({ ...climb, seq: 9, climbUuid: 'older' }), JSON.stringify(climb)],
    ]);
    expect(await store.getBoardDiscoveryClimb('42')).toEqual(expect.objectContaining({ uuid: 'climb-one' }));
  });

  it('never falls past a newer mismatched writer to an older matching climb', async () => {
    evaluate.mockResolvedValue([
      'holder-one',
      [JSON.stringify(climb), JSON.stringify({ ...climb, seq: 11, sentByUserId: 'new-holder' })],
    ]);
    expect(await store.getBoardDiscoveryClimb('42')).toBeNull();
  });

  it('returns null on Redis failure, even when Redis is required', async () => {
    evaluate.mockRejectedValue(new Error('Redis unavailable'));
    expect(await store.getBoardDiscoveryClimb('42')).toBeNull();
  });

  it('does not read history when Redis is disconnected', async () => {
    const disconnected = new BoardPresenceStore({
      isRedisAvailable: () => false,
      isRedisRequired: () => false,
      logger: { error: vi.fn(), warn: vi.fn() },
    });
    expect(await disconnected.getBoardDiscoveryClimb('42')).toBeNull();
    expect(evaluate).not.toHaveBeenCalled();
  });
});
