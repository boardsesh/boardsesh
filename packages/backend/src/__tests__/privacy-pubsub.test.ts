import { EventEmitter } from 'node:events';
import type Redis from 'ioredis';
import { describe, expect, it, vi } from 'vite-plus/test';
import { createRedisPubSubAdapter } from '../pubsub/redis-adapter';

function redisPair() {
  const subscriber = new EventEmitter();
  const subscribe = vi.fn().mockResolvedValue(1);
  const unsubscribe = vi.fn().mockResolvedValue(0);
  Object.assign(subscriber, { subscribe, unsubscribe });
  const publish = vi.fn().mockResolvedValue(1);
  const adapter = createRedisPubSubAdapter({ publish } as unknown as Redis, subscriber as unknown as Redis);
  return { adapter, subscriber, publish, subscribe, unsubscribe };
}

describe('opaque privacy invalidations', () => {
  it('delivers across instances without sending account or resource identifiers', async () => {
    const sender = redisPair();
    const receiver = redisPair();
    const invalidate = vi.fn();
    receiver.adapter.onPrivacyMessage(invalidate);
    await receiver.adapter.subscribePrivacyChannel();
    await sender.adapter.publishPrivacyChanged();
    const [channel, payload] = sender.publish.mock.calls[0] as [string, string];
    expect(channel).toBe('boardsesh:privacy:global');
    expect(JSON.parse(payload)).toEqual({
      instanceId: sender.adapter.getInstanceId(),
      event: { invalidated: true },
      timestamp: expect.any(Number),
    });
    receiver.subscriber.emit('message', channel, payload);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith();
  });
  it('deduplicates local echoes and releases the global subscription', async () => {
    const instance = redisPair();
    const invalidate = vi.fn();
    instance.adapter.onPrivacyMessage(invalidate);
    await instance.adapter.subscribePrivacyChannel();
    await instance.adapter.subscribePrivacyChannel();
    expect(instance.subscribe).toHaveBeenCalledTimes(1);
    await instance.adapter.publishPrivacyChanged();
    const [channel, payload] = instance.publish.mock.calls[0] as [string, string];
    instance.subscriber.emit('message', channel, payload);
    expect(invalidate).not.toHaveBeenCalled();
    await instance.adapter.unsubscribePrivacyChannel();
    expect(instance.unsubscribe).toHaveBeenCalledWith('boardsesh:privacy:global');
  });
});
