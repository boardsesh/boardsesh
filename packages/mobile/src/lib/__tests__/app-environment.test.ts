import { afterEach, describe, it, expect } from 'vitest';
import { resolveAppEnvironment } from '../app-environment';

// Moved out of sentry.test.ts (#3814): the resolver is now shared by Sentry and
// PostHog, so it gets its own test file rather than living under either SDK's.
describe('resolveAppEnvironment', () => {
  const previous = process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT;
  afterEach(() => {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT;
    else process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT = previous;
  });

  it("defaults to 'production' when EXPO_PUBLIC_SENTRY_ENVIRONMENT is unset", () => {
    delete process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT;
    expect(resolveAppEnvironment()).toBe('production');
  });

  it("defaults to 'production' when EXPO_PUBLIC_SENTRY_ENVIRONMENT is empty", () => {
    process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT = '';
    expect(resolveAppEnvironment()).toBe('production');
  });

  it('uses the preview value published onto pr-* OTA bundles', () => {
    process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT = 'preview';
    expect(resolveAppEnvironment()).toBe('preview');
  });
});
