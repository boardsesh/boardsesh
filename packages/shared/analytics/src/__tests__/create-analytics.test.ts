import { describe, it, expect, vi } from 'vitest';
import { createAnalytics } from '../create-analytics';
import type { PostHogClient } from '../client';

function fakeClient() {
  const capture = vi.fn();
  const identify = vi.fn();
  const alias = vi.fn();
  const reset = vi.fn();
  const setPersonProperties = vi.fn();
  const client: PostHogClient = { capture, identify, alias, reset, setPersonProperties };
  return { client, capture, identify, alias, reset, setPersonProperties };
}

describe('createAnalytics', () => {
  it('forwards track to capture with undefined properties stripped', () => {
    const fake = fakeClient();
    const analytics = createAnalytics(() => fake.client);

    analytics.track('Tick Logged', { boardLayout: 'kilter', error: undefined, count: 0 });

    expect(fake.capture).toHaveBeenCalledWith('Tick Logged', { boardLayout: 'kilter', count: 0 });
  });

  it('no-ops every method when the client is null', () => {
    const analytics = createAnalytics(() => null);

    expect(() => analytics.track('Session Started')).not.toThrow();
    expect(analytics.capture('Session Started')).toBe(false);
    expect(analytics.identify('user-1')).toBe(false);
    expect(analytics.setPersonProperties({ language: 'en' })).toBe(false);
    expect(analytics.alias('user-1')).toBe(false);
    expect(analytics.reset()).toBe(false);
  });

  it('returns true from boolean methods when a client is present', () => {
    const fake = fakeClient();
    const analytics = createAnalytics(() => fake.client);

    expect(analytics.capture('X')).toBe(true);
    expect(analytics.identify('user-1', { email: 'a@b.com' })).toBe(true);
    expect(analytics.setPersonProperties({ language: 'fr' }, { signup_at: '2024' })).toBe(true);
    expect(analytics.alias('user-1')).toBe(true);
    expect(analytics.reset()).toBe(true);

    expect(fake.identify).toHaveBeenCalledWith('user-1', { email: 'a@b.com' });
    expect(fake.setPersonProperties).toHaveBeenCalledWith({ language: 'fr' }, { signup_at: '2024' });
    expect(fake.alias).toHaveBeenCalledWith('user-1');
  });

  it('drops calls and never resolves the client when shouldSkip returns true', () => {
    const fake = fakeClient();
    const getClient = vi.fn(() => fake.client);
    const analytics = createAnalytics(getClient, { shouldSkip: () => true });

    analytics.track('Session Started');
    expect(analytics.capture('X')).toBe(false);
    expect(analytics.identify('user-1')).toBe(false);

    expect(fake.capture).not.toHaveBeenCalled();
    // track short-circuits on shouldSkip before ever calling getClient.
    expect(getClient).not.toHaveBeenCalled();
  });

  it('invokes onDebug for track even when no client is present', () => {
    const onDebug = vi.fn();
    const analytics = createAnalytics(() => null, { onDebug });

    analytics.track('Session Started', { boardName: 'tension' });

    expect(onDebug).toHaveBeenCalledWith('Session Started', { boardName: 'tension' });
  });

  it('does not invoke onDebug when the call is skipped', () => {
    const onDebug = vi.fn();
    const analytics = createAnalytics(() => fakeClient().client, { shouldSkip: () => true, onDebug });

    analytics.track('Session Started');

    expect(onDebug).not.toHaveBeenCalled();
  });
});
