import { describe, it, expect, vi, beforeEach } from 'vitest';

// dev-launcher.ts calls requireOptionalNativeModule('ExpoDevLauncher') at module
// scope. We control what it returns per test by reassigning the variable the mock
// factory closes over, then re-importing the module against the fresh value.
type LauncherMock = { loadApp(url: string): Promise<boolean> } | null;

let launcherMock: LauncherMock = null;

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => launcherMock,
}));

// resetModules forces dev-launcher.ts to re-run its top-level probe against the
// freshly assigned launcherMock instead of freezing the first import's value.
async function loadDevLauncher() {
  vi.resetModules();
  return await import('../dev-launcher');
}

beforeEach(() => {
  launcherMock = null;
});

describe('isDevLauncherAvailable', () => {
  it('reports unavailable when ExpoDevLauncher is not linked (App Store / TestFlight binary)', async () => {
    launcherMock = null;
    const { isDevLauncherAvailable, expoDevLauncher } = await loadDevLauncher();

    expect(isDevLauncherAvailable()).toBe(false);
    expect(expoDevLauncher).toBeNull();
  });

  it('reports available when ExpoDevLauncher is linked (dev-client build)', async () => {
    const loadApp = vi.fn().mockResolvedValue(true);
    launcherMock = { loadApp };
    const { isDevLauncherAvailable, expoDevLauncher } = await loadDevLauncher();

    expect(isDevLauncherAvailable()).toBe(true);
    expect(expoDevLauncher).toBe(launcherMock);
  });
});
