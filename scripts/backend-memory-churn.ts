/**
 * Reconnect/quiet-stream soak without external services:
 * vp exec node --expose-gc --import tsx scripts/backend-memory-churn.ts 1800
 * GC is used only in this local diagnostic, never by the backend service.
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createAsyncIterator } from '../packages/backend/src/graphql/resolvers/shared/async-iterators';
import { withSubscriptionCleanup } from '../packages/backend/src/graphql/resolvers/shared/managed-subscription';
import { PubSubChannel } from '../packages/backend/src/pubsub/channel';

const durationSeconds = Number(process.argv[2] ?? 1800);
assert(Number.isFinite(durationSeconds) && durationSeconds >= 1 && durationSeconds <= 7200);
const channel = new PubSubChannel<string>({
  label: 'memory-soak',
  isRedisRequired: () => false,
  logger: {
    error: () => {
      throw new Error('Unexpected pubsub error');
    },
  },
});
const subscribe = withSubscriptionCleanup(async function* (lifetime, sessionId: string) {
  const source = await lifetime.own(createAsyncIterator<string>((push) => channel.subscribe(sessionId, push)));
  yield 'ready';
  for await (const event of source) yield event;
});

async function main(): Promise<void> {
  const startedAt = performance.now();
  let cycles = 0;
  let nextSampleAt = startedAt;
  while (performance.now() - startedAt < durationSeconds * 1000) {
    for (let batchIndex = 0; batchIndex < 100; batchIndex++) {
      const sessionId = `session-${cycles}`;
      const iterator = subscribe(sessionId);
      await iterator.next();
      if (batchIndex % 2 === 0) {
        channel.publish(sessionId, 'active event');
        assert.equal((await iterator.next()).value, 'active event');
      }
      const pending = iterator.next();
      await iterator.return();
      assert.equal((await pending).done, true);
      cycles += 1;
    }
    assert.deepEqual(channel.getRuntimeStats(), { channels: 0, subscribers: 0 });
    // Let finalizers/microtasks settle before measuring the next batch.
    await delay(1000);
    if (performance.now() >= nextSampleAt) {
      globalThis.gc?.();
      console.info(
        JSON.stringify({
          seconds: Math.round((performance.now() - startedAt) / 1000),
          cycles,
          ...process.memoryUsage(),
          ...channel.getRuntimeStats(),
        }),
      );
      nextSampleAt = performance.now() + 60_000;
    }
  }
  globalThis.gc?.();
  console.info(
    JSON.stringify({ complete: true, durationSeconds, cycles, ...process.memoryUsage(), ...channel.getRuntimeStats() }),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
