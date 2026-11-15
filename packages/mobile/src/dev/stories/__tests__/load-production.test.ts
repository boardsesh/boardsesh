import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('story entry points in production', () => {
  it('never evaluates story screens, root or error boundary modules', async () => {
    vi.stubGlobal('__DEV__', false);
    const load = await import('../load');
    expect(load.loadStoryScreens()).toBeNull();
    expect(load.loadStoryTabLayouts()).toBeNull();
    expect(load.loadNativeActivitySetup()).toBeNull();
    expect(load.loadStoryRoot()).toBeNull();
    expect(load.loadStoryErrorBoundary()).toBeNull();
    expect(Object.keys(load).sort()).toEqual([
      'loadNativeActivitySetup',
      'loadStoryErrorBoundary',
      'loadStoryRoot',
      'loadStoryScreens',
      'loadStoryTabLayouts',
    ]);
  });
});
