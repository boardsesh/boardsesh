import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

type RedisEventHandler = (...arguments_: unknown[]) => void;

type FakeRedisInstance = {
  emit: (event: string, ...arguments_: unknown[]) => void;
};

const redisMockState = vi.hoisted(() => ({
  instances: [] as FakeRedisInstance[],
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
});
