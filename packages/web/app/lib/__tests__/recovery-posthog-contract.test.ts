import { describe, expect, it } from 'vite-plus/test';
import { PostHog } from 'posthog-js-lite';
import { scrubShareCapabilitiesFromEvent } from '../share-capability';

type PersistedKey = Parameters<PostHog['setPersistedProperty']>[0];

describe('actual PostHog enrichment at the recovery privacy boundary', () => {
  it.each([
    ['reset-password', '?'],
    ['reset-password', '#'],
    ['confirm-first-password', '?'],
    ['confirm-first-password', '#'],
  ])('scrubs SDK-added %s URL, referrer and person copies with marker%s without network', async (path, marker) => {
    const originalLocation = window.location;
    const originalReferrer = Object.getOwnPropertyDescriptor(document, 'referrer');
    const token = 'a363934b-b7ba-41ba-a279-52185daa100e';
    const url = `https://www.boardsesh.com/fr/auth/${path}${marker}%74oken=${token}&%65mail=Climber%40example.test&src=mail`;
    Object.defineProperty(window, 'location', { value: new URL(url), configurable: true });
    let nestedReferrer = url;
    for (let depth = 0; depth < 6; depth += 1) nestedReferrer = encodeURIComponent(nestedReferrer);
    Object.defineProperty(document, 'referrer', {
      value: `https://www.boardsesh.com/auth/login?callbackUrl=${nestedReferrer}`,
      configurable: true,
    });
    const enriched: string[] = [];
    const client = new PostHog('synthetic-offline-key', {
      persistence: 'memory',
      preloadFeatureFlags: false,
      disableRemoteFeatureFlags: true,
      flushInterval: 0,
      defaultOptIn: true,
      before_send(event) {
        enriched.push(JSON.stringify(event));
        return scrubShareCapabilitiesFromEvent(event);
      },
    });
    client.fetch = async () => {
      throw new Error('Offline fixture forbids telemetry transport');
    };
    try {
      client.capture('$pageview', { $current_url: `/fr/auth/${path}` });
      const queued = JSON.stringify(client.getPersistedProperty('queue' as PersistedKey));
      expect(enriched.some((event) => event.includes(token))).toBe(true);
      expect(enriched.some((event) => event.includes('callbackUrl='))).toBe(true);
      expect(queued).not.toContain(token);
      expect(queued).not.toContain('Climber');
      expect(queued).not.toContain('src=mail');
    } finally {
      for (const key of ['queue', 'ai_queue', 'ai_capture_queue', 'logs_queue'])
        client.setPersistedProperty(key as PersistedKey, null);
      await client.shutdown(100);
      Object.defineProperty(window, 'location', { value: originalLocation, configurable: true });
      if (originalReferrer) Object.defineProperty(document, 'referrer', originalReferrer);
      else Reflect.deleteProperty(document, 'referrer');
    }
  });
});
