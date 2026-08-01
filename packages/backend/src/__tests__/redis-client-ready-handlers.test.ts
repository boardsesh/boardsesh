import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

type RedisEventHandler = (...arguments_: unknown[]) => void;

type FakeRedisInstance = {
  emit: (event: string, ...arguments_: unknown[]) => void;
};

const redisMockState = vi.hoisted(() => ({
  instances: [] as FakeRedisInstance[],
  setCalls: [] as unknown[][],
  setHandler: null as ((...arguments_: unknown[]) => Promise<'OK' | null>) | null,
  deferQuitClose: false,
  pendingQuitClosures: [] as Array<() => void>,
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
      if (redisMockState.deferQuitClose) {
        return new Promise<'OK'>((resolve) => {
          redisMockState.pendingQuitClosures.push(() => {
            this.emit('close');
            resolve('OK');
          });
        });
      }
      this.emit('close');
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
  redisMockState.deferQuitClose = false;
  redisMockState.pendingQuitClosures.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('RedisClientManager recovery readiness', () => {
  it('includes a handler registered while the current readiness barrier is in flight', async () => {
    const { RedisClientManager } = await import('../redis/client');
    const manager = new RedisClientManager();
    let finishInitialHandler: (() => void) | undefined;
    let finishLateHandler: (() => void) | undefined;
    const initialHandler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishInitialHandler = resolve;
        }),
    );
    const lateHandler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLateHandler = resolve;
        }),
    );
    manager.onRedisReady(initialHandler);

    const connection = manager.connect();
    const [publisher, subscriber, streamConsumer] = redisMockState.instances;
    publisher?.emit('ready');
    subscriber?.emit('ready');
    streamConsumer?.emit('ready');
    await vi.waitFor(() => expect(initialHandler).toHaveBeenCalledTimes(1));

    manager.onRedisReady(lateHandler);
    finishInitialHandler?.();
    await vi.waitFor(() => expect(lateHandler).toHaveBeenCalledTimes(1));
    expect(manager.isRedisConnected()).toBe(false);

    finishLateHandler?.();
    await expect(connection).resolves.toBe(true);
    expect(manager.isRedisConnected()).toBe(true);
    await manager.disconnect();
  });

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

  it('runs readiness handlers again after an explicit disconnect and fresh connect', async () => {
    const { RedisClientManager } = await import('../redis/client');
    const manager = new RedisClientManager();
    const readyHandler = vi.fn().mockResolvedValue(undefined);
    manager.onRedisReady(readyHandler);

    const firstConnection = manager.connect();
    const [firstPublisher, firstSubscriber, firstStreamConsumer] = redisMockState.instances;
    firstPublisher?.emit('ready');
    firstSubscriber?.emit('ready');
    firstStreamConsumer?.emit('ready');
    await expect(firstConnection).resolves.toBe(true);
    expect(readyHandler).toHaveBeenCalledTimes(1);

    await manager.disconnect();
    expect(manager.isRedisConnected()).toBe(false);

    const secondConnection = manager.connect();
    const [secondPublisher, secondSubscriber, secondStreamConsumer] = redisMockState.instances.slice(3);
    secondPublisher?.emit('ready');
    secondSubscriber?.emit('ready');
    secondStreamConsumer?.emit('ready');
    await expect(secondConnection).resolves.toBe(true);
    expect(readyHandler).toHaveBeenCalledTimes(2);
    expect(manager.isRedisConnected()).toBe(true);
    await manager.disconnect();
  });

  it('does not advertise a stale connection while explicit disconnect is waiting for close events', async () => {
    const { RedisClientManager } = await import('../redis/client');
    const manager = new RedisClientManager();
    let finishReadyHandler: (() => void) | undefined;
    manager.onRedisReady(
      () =>
        new Promise<void>((resolve) => {
          finishReadyHandler = resolve;
        }),
    );

    const connection = manager.connect();
    const [publisher, subscriber, streamConsumer] = redisMockState.instances;
    publisher?.emit('ready');
    subscriber?.emit('ready');
    streamConsumer?.emit('ready');
    await vi.waitFor(() => expect(finishReadyHandler).toBeTypeOf('function'));

    redisMockState.deferQuitClose = true;
    const disconnection = manager.disconnect();
    await vi.waitFor(() => expect(redisMockState.pendingQuitClosures).toHaveLength(3));
    finishReadyHandler?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.isRedisConnected()).toBe(false);

    for (const emitClose of redisMockState.pendingQuitClosures.splice(0)) emitClose();
    await disconnection;
    await expect(connection).resolves.toBe(false);
    expect(manager.isRedisConnected()).toBe(false);
  });

  it('fails closed when readiness handlers recursively register more handlers', async () => {
    const { RedisClientManager } = await import('../redis/client');
    const manager = new RedisClientManager();
    const registerNextHandler = () => {
      manager.onRedisReady(async () => registerNextHandler());
    };
    registerNextHandler();

    const connection = manager.connect();
    const [publisher, subscriber, streamConsumer] = redisMockState.instances;
    publisher?.emit('ready');
    subscriber?.emit('ready');
    streamConsumer?.emit('ready');

    await expect(connection).rejects.toThrow('Redis recovery handlers did not settle after 100 passes');
    expect(manager.isRedisConnected()).toBe(false);
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
