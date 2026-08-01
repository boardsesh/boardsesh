import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

type RedisEventHandler = (...arguments_: unknown[]) => void;

type FakeRedisInstance = {
  emit: (event: string, ...arguments_: unknown[]) => void;
};

const redisMockState = vi.hoisted(() => ({
  instances: [] as FakeRedisInstance[],
  setCalls: [] as unknown[][],
  setHandler: null as ((...arguments_: unknown[]) => Promise<'OK' | null>) | null,
}));

vi.mock('ioredis', () => {
  class FakeRedis {
    private readonly handlers = new Map<string, RedisEventHandler[]>();

    constructor() {
      redisMockState.instances.push(this);
    }

    on(event: string, handler: RedisEventHandler): this {
      const eventHandlers = this.handlers.get(event) ?? [];
      eventHandlers.push(handler);
      this.handlers.set(event, eventHandlers);
      return this;
    }

    emit(event: string, ...arguments_: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...arguments_);
    }

    async info(): Promise<string> {
      return 'redis_version:7.2.0\r\n';
    }

    async set(...arguments_: unknown[]): Promise<'OK' | null> {
      redisMockState.setCalls.push(arguments_);
      return redisMockState.setHandler?.(...arguments_) ?? 'OK';
    }

    async quit(): Promise<'OK'> {
      return 'OK';
    }
  }

  return { default: FakeRedis };
});

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('REDIS_URL', 'redis://ready-handler.test');
  redisMockState.instances.length = 0;
  redisMockState.setCalls.length = 0;
  redisMockState.setHandler = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('RedisClientManager recovery readiness', () => {
  it('reruns recovery handlers when a connection closes and becomes ready during reconciliation', async () => {
    const { RedisClientManager } = await import('../redis/client');
    const manager = new RedisClientManager();
    const finishHandlers: Array<() => void> = [];
    const readyHandler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishHandlers.push(resolve);
        }),
    );
    manager.onRedisReady(readyHandler);

    const connection = manager.connect();
    expect(redisMockState.instances).toHaveLength(3);
    const [publisher, subscriber, streamConsumer] = redisMockState.instances;
    publisher?.emit('ready');
    subscriber?.emit('ready');
    streamConsumer?.emit('ready');
    await vi.waitFor(() => expect(readyHandler).toHaveBeenCalledTimes(1));
    expect(manager.isRedisConnected()).toBe(false);

    publisher?.emit('close');
    publisher?.emit('ready');
    finishHandlers[0]?.();

    await vi.waitFor(() => expect(readyHandler).toHaveBeenCalledTimes(2));
    expect(manager.isRedisConnected()).toBe(false);

    finishHandlers[1]?.();
    await expect(connection).resolves.toBe(true);
    expect(manager.isRedisConnected()).toBe(true);
    await manager.disconnect();
  });

  it('promotes claims admitted during recovery before advertising Redis as connected', async () => {
    const { redisClientManager } = await import('../redis/client');
    const { acquireGymDuplicateReportClaim, resetGymDuplicateReportClaimsForTests } =
      await import('../utils/gym-duplicate-report-claims');
    const firstKey = 'gymDuplicateReport:test:manager-first';
    const secondKey = 'gymDuplicateReport:test:manager-second';
    let finishFirstPromotion: (() => void) | undefined;
    let finishSecondPromotion: (() => void) | undefined;
    redisMockState.setHandler = (key) =>
      new Promise<'OK'>((resolve) => {
        if (key === firstKey) finishFirstPromotion = () => resolve('OK');
        if (key === secondKey) finishSecondPromotion = () => resolve('OK');
      });
    const disconnectedDependencies = (ownerToken: string) => ({
      isRedisConnected: () => false,
      getRedisClient: () => {
        throw new Error('Redis is still hidden from request handlers');
      },
      createOwnerToken: () => ownerToken,
      now: Date.now,
    });
    await acquireGymDuplicateReportClaim(firstKey, disconnectedDependencies('first-owner'));

    const connection = redisClientManager.connect();
    const [publisher, subscriber, streamConsumer] = redisMockState.instances;
    publisher?.emit('ready');
    subscriber?.emit('ready');
    streamConsumer?.emit('ready');
    await vi.waitFor(() => expect(redisMockState.setCalls.map(([key]) => key)).toEqual([firstKey]));
    expect(redisClientManager.isRedisConnected()).toBe(false);

    await acquireGymDuplicateReportClaim(secondKey, disconnectedDependencies('second-owner'));
    finishFirstPromotion?.();
    await vi.waitFor(() => expect(redisMockState.setCalls.map(([key]) => key)).toEqual([firstKey, secondKey]));
    expect(redisClientManager.isRedisConnected()).toBe(false);

    finishSecondPromotion?.();
    await expect(connection).resolves.toBe(true);
    expect(redisClientManager.isRedisConnected()).toBe(true);
    resetGymDuplicateReportClaimsForTests();
    await redisClientManager.disconnect();
  });
});
