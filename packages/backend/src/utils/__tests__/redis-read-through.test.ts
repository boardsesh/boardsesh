import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { redisStore, redisState, getMock, setMock, loggerErrorMock } = vi.hoisted(() => ({
  redisStore: new Map<string, string>(),
  redisState: { connected: true },
  getMock: vi.fn(),
  setMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('../logger', () => ({ logger: { error: loggerErrorMock, info: vi.fn(), warn: vi.fn() } }));

vi.mock('../../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: () => redisState.connected,
    getClients: () => ({ publisher: { get: getMock, set: setMock } }),
  },
}));

import { readThroughRedis } from '../redis-read-through';
import { resetSingleFlightForTests } from '../single-flight';

const read = (load: () => Promise<unknown>, key = 'test:v1:key') =>
  readThroughRedis({ key, ttlSeconds: 600, label: 'Test', load });

describe('readThroughRedis', () => {
  beforeEach(() => {
    redisStore.clear();
    redisState.connected = true;
    loggerErrorMock.mockReset();
    getMock.mockReset();
    getMock.mockImplementation(async (key: string) => redisStore.get(key) ?? null);
    setMock.mockReset();
    setMock.mockImplementation(async (key: string, value: string) => {
      redisStore.set(key, value);
      return 'OK';
    });
    resetSingleFlightForTests();
  });

  afterEach(() => resetSingleFlightForTests());

  it('loads once on a miss, stores with the TTL, and answers the next call from Redis', async () => {
    const load = vi.fn(async () => ({ count: 283 }));

    expect(await read(load)).toEqual({ count: 283 });
    expect(await read(load)).toEqual({ count: 283 });

    expect(load).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith('test:v1:key', JSON.stringify({ count: 283 }), 'EX', 600);
  });

  it('treats a cached zero as a hit', async () => {
    const load = vi.fn(async () => 0);

    await read(load);
    expect(await read(load)).toBe(0);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps separate keys separate', async () => {
    const load = vi.fn(async () => 1);

    await read(load, 'a');
    await read(load, 'b');

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent misses onto one load', async () => {
    const load = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve('value'), 10)));

    const results = await Promise.all([read(load), read(load), read(load)]);

    expect(results).toEqual(['value', 'value', 'value']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('falls through to the load when Redis read and write both fail', async () => {
    getMock.mockRejectedValue(new Error('ECONNREFUSED'));
    setMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const load = vi.fn(async () => 'fresh');

    expect(await read(load)).toBe('fresh');
    expect(load).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledTimes(2);
  });

  it('runs the load without touching Redis when Redis is not connected', async () => {
    redisState.connected = false;
    const load = vi.fn(async () => 'fresh');

    expect(await read(load)).toBe('fresh');
    expect(await read(load)).toBe('fresh');

    expect(load).toHaveBeenCalledTimes(2);
    expect(getMock).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
  });

  it('does not cache a failed load', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('statement timeout')).mockResolvedValueOnce('second');

    await expect(read(load)).rejects.toThrow('statement timeout');
    expect(await read(load)).toBe('second');
    expect(setMock).toHaveBeenCalledTimes(1);
  });
});
