import { describe, it, expect } from 'vite-plus/test';
import { PostHog } from 'posthog-js-lite';
type PersistedKey = Parameters<PostHog['setPersistedProperty']>[0];
describe('installed PostHog withdrawal contract', () => {
  it('requires explicit queue discard because reset preserves queues and clears the opt state', async () => {
    const client = new PostHog('test', {
      persistence: 'memory',
      preloadFeatureFlags: false,
      disableRemoteFeatureFlags: true,
      flushInterval: 0,
      defaultOptIn: true,
    });
    await client.optOut();
    for (const key of ['queue', 'ai_queue', 'ai_capture_queue', 'logs_queue'])
      client.setPersistedProperty(key as PersistedKey, [{ message: { event: 'pending' } }]);
    client.reset([]);
    await Promise.resolve();
    expect(client.optedOut).toBe(false);
    for (const key of ['queue', 'ai_queue', 'ai_capture_queue', 'logs_queue']) {
      expect(client.getPersistedProperty(key as PersistedKey)).toEqual([{ message: { event: 'pending' } }]);
      client.setPersistedProperty(key as PersistedKey, null);
    }
    await client.optOut();
    expect(client.optedOut).toBe(true);
    await client.shutdown(100);
  });
});
