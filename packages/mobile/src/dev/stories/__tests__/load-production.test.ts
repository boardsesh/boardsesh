import { afterEach, describe, expect, it, vi } from 'vitest';

// The player's story override (#7000) must be a no-op in a production bundle:
// with `__DEV__` false, `useDevScenarioPlayer` is the plain function that
// returns null, whatever a story left in the overrides store.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function loadWithDev(dev: boolean) {
  vi.stubGlobal('__DEV__', dev);
  vi.resetModules();
  const overrides = await import('../scenario-overrides');
  const load = await import('../load');
  return { overrides, load };
}

describe('useDevScenarioPlayer in production', () => {
  it('is the null-returning no-op and ignores a forced player', async () => {
    const { overrides, load } = await loadWithDev(false);
    overrides.setScenarioOverrides({ player: { wallPill: 'browsing', wallLit: 'lit' } });
    expect(load.useDevScenarioPlayer.name).toBe('noScenarioPlayer');
    // Callable outside a component: it is not a hook in production.
    expect(load.useDevScenarioPlayer()).toBeNull();
    overrides.setScenarioOverrides(null);
  });

  it('reads the store in development', async () => {
    const { load } = await loadWithDev(true);
    expect(load.useDevScenarioPlayer.name).toBe('useScenarioPlayerFromStories');
  });
});
