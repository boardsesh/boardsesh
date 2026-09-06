import { beforeEach, describe, expect, it, vi } from 'vitest';

// xprem's two internals, mocked at the deep paths `qa-surf` imports them from.
// Nothing else in the app is allowed to reach them, so these two mocks are the
// whole seam.
const surf = vi.hoisted(() => ({
  listBranches: vi.fn(),
  surfTo: vi.fn(),
}));
const config = vi.hoisted(() => ({
  readConfig: vi.fn(),
  readLoadedState: vi.fn(() => ({ branch: null as string | null, refusedBranch: null as string | null })),
}));
const updates = vi.hoisted(() => ({
  isEnabled: true,
  manifest: { extra: {} } as unknown,
  setUpdateRequestHeadersOverride: vi.fn(),
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
}));
// `__DEV__` is substituted textually by both Metro and Vitest, so the dev branch
// can only be exercised through this helper — which is exactly why qa-surf
// delegates to it instead of testing `__DEV__` itself.
const migration = vi.hoisted(() => ({ isBranchSurfingBuild: vi.fn(() => true) }));

vi.mock('@xprem/control-center/src/surf', () => ({
  listBranches: surf.listBranches,
  surfTo: surf.surfTo,
}));
// Partial: the two readers are stubbed, but BRANCH_HEADER comes from the real
// package so the header name still has exactly one definition. Safe to load — that
// module imports only expo-constants and expo-updates, both mocked above.
vi.mock('@xprem/control-center/src/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xprem/control-center/src/config')>()),
  readConfig: config.readConfig,
  readLoadedState: config.readLoadedState,
}));
vi.mock('expo-updates', () => ({
  get isEnabled() {
    return updates.isEnabled;
  },
  get manifest() {
    return updates.manifest;
  },
  setUpdateRequestHeadersOverride: updates.setUpdateRequestHeadersOverride,
  checkForUpdateAsync: updates.checkForUpdateAsync,
  fetchUpdateAsync: updates.fetchUpdateAsync,
  reloadAsync: updates.reloadAsync,
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { updates: {} } } }));
vi.mock('../../legacy-ota-channel-migration', () => ({
  isBranchSurfingBuild: migration.isBranchSurfingBuild,
}));

import {
  BRANCH_SURFING_UNAVAILABLE_MESSAGE,
  listPrBranches,
  qaSurfingAvailable,
  readRefusedPrNumber,
  readRunningPrNumber,
  surfToPr,
  surfToProduction,
  surfToUnlistedPr,
} from '../qa-surf';

const SURF_CONFIG = {
  baseUrl: 'https://updates.boardsesh.com',
  appId: 'app-id',
  channel: 'production',
  runtimeVersion: 'fingerprint',
  requestHeaders: {},
};

beforeEach(() => {
  surf.listBranches.mockReset();
  surf.surfTo.mockReset();
  config.readConfig.mockReset().mockReturnValue(SURF_CONFIG);
  config.readLoadedState.mockReset().mockReturnValue({ branch: null, refusedBranch: null });
  migration.isBranchSurfingBuild.mockReset().mockReturnValue(true);
  updates.isEnabled = true;
  updates.manifest = { extra: {} };
  updates.setUpdateRequestHeadersOverride.mockReset();
  updates.checkForUpdateAsync.mockReset();
  updates.fetchUpdateAsync.mockReset().mockResolvedValue(undefined);
  updates.reloadAsync.mockReset().mockResolvedValue(undefined);
});

describe('qaSurfingAvailable', () => {
  it('is true on a build with surfing headers and a usable config', () => {
    expect(qaSurfingAvailable()).toBe(true);
  });

  it('is false on a build that was never meant to surf', () => {
    migration.isBranchSurfingBuild.mockReturnValue(false);
    expect(qaSurfingAvailable()).toBe(false);
  });

  it('does not ask xprem for a config on a build that cannot surf', () => {
    // readConfig console.warns loudly about missing build-time headers. That is
    // the right noise for a build that was MEANT to surf, and pure noise on a
    // dev client — so the capability check has to come first.
    migration.isBranchSurfingBuild.mockReturnValue(false);
    qaSurfingAvailable();
    expect(config.readConfig).not.toHaveBeenCalled();
  });

  it('is false when xprem cannot build a config', () => {
    config.readConfig.mockReturnValue(null);
    expect(qaSurfingAvailable()).toBe(false);
  });
});

describe('readRunningPrNumber', () => {
  it('reads the PR out of the running branch marker', () => {
    updates.manifest = { extra: { branch: 'pr-4792' } };
    expect(readRunningPrNumber()).toBe(4792);
  });

  it('is null on production', () => {
    expect(readRunningPrNumber()).toBeNull();
  });

  it('is null on a non-PR branch', () => {
    updates.manifest = { extra: { branch: 'feature-native-update' } };
    expect(readRunningPrNumber()).toBeNull();
  });
});

describe('readRefusedPrNumber', () => {
  it('reports a branch the server refused because it crashed here', () => {
    config.readLoadedState.mockReturnValue({ branch: null, refusedBranch: 'pr-4792' });
    expect(readRefusedPrNumber()).toBe(4792);
  });

  it('is null when nothing was refused', () => {
    expect(readRefusedPrNumber()).toBeNull();
  });
});

describe('listPrBranches', () => {
  it('keeps only pr-<n> branches, freshest first', () => {
    surf.listBranches.mockResolvedValue({
      total: 4,
      branches: [
        { name: 'pr-100', lastUpdateAt: '2026-08-20T10:00:00.000Z' },
        { name: 'production', lastUpdateAt: '2026-08-26T10:00:00.000Z' },
        { name: 'pr-200', lastUpdateAt: '2026-08-25T10:00:00.000Z' },
        { name: 'feature-native-update', lastUpdateAt: '2026-08-24T10:00:00.000Z' },
      ],
    });

    return expect(listPrBranches()).resolves.toEqual([
      { prNumber: 200, branch: 'pr-200', lastUpdateAt: '2026-08-25T10:00:00.000Z' },
      { prNumber: 100, branch: 'pr-100', lastUpdateAt: '2026-08-20T10:00:00.000Z' },
    ]);
  });

  it('sinks an unparseable timestamp instead of scrambling the order', async () => {
    surf.listBranches.mockResolvedValue({
      total: 2,
      branches: [
        { name: 'pr-1', lastUpdateAt: 'not a date' },
        { name: 'pr-2', lastUpdateAt: '2026-08-25T10:00:00.000Z' },
      ],
    });

    const branches = await listPrBranches();
    expect(branches?.map((entry) => entry.prNumber)).toEqual([2, 1]);
  });

  it('returns null when surfing is switched off for this channel', async () => {
    // Distinct from an empty array, which means surfing is on but nothing is
    // published for this runtime version.
    surf.listBranches.mockResolvedValue(null);
    await expect(listPrBranches()).resolves.toBeNull();
  });

  it('returns an empty list when nothing is published', async () => {
    surf.listBranches.mockResolvedValue({ total: 0, branches: [] });
    await expect(listPrBranches()).resolves.toEqual([]);
  });

  it('passes the abort signal through', async () => {
    surf.listBranches.mockResolvedValue({ total: 0, branches: [] });
    const controller = new AbortController();
    await listPrBranches(controller.signal);
    // `true` is the whole list, not xprem's default newest-50 page: the screen
    // has no "show the rest" affordance, so a page cap silently hides PRs.
    expect(surf.listBranches).toHaveBeenCalledWith(SURF_CONFIG, controller.signal, true);
  });

  it('propagates an unreachable update server', async () => {
    surf.listBranches.mockRejectedValue(new Error('Could not reach the update server (502).'));
    await expect(listPrBranches()).rejects.toThrow('Could not reach the update server (502).');
  });

  it('refuses to run on a build that cannot surf', async () => {
    migration.isBranchSurfingBuild.mockReturnValue(false);
    await expect(listPrBranches()).rejects.toThrow(BRANCH_SURFING_UNAVAILABLE_MESSAGE);
    expect(surf.listBranches).not.toHaveBeenCalled();
  });
});

describe('surfToPr / surfToProduction', () => {
  it('pins the PR branch and reports the outcome', async () => {
    surf.surfTo.mockResolvedValue('reloading');
    await expect(surfToPr(4792)).resolves.toBe('reloading');
    expect(surf.surfTo).toHaveBeenCalledWith(SURF_CONFIG, 'pr-4792');
  });

  it('clears the pin with null rather than a channel name', async () => {
    // null is "no override at all" — the native side reverts to the headers
    // baked at build time, the one state that cannot be wrong.
    surf.surfTo.mockResolvedValue('nothing-to-load');
    await expect(surfToProduction()).resolves.toBe('nothing-to-load');
    expect(surf.surfTo).toHaveBeenCalledWith(SURF_CONFIG, null);
  });

  it('refuses to surf on a build with no usable config', async () => {
    config.readConfig.mockReturnValue(null);
    await expect(surfToPr(1)).rejects.toThrow(BRANCH_SURFING_UNAVAILABLE_MESSAGE);
    await expect(surfToProduction()).rejects.toThrow(BRANCH_SURFING_UNAVAILABLE_MESSAGE);
    expect(surf.surfTo).not.toHaveBeenCalled();
  });
});

// The whole point of `surfToUnlistedPr`: a branch pin is persistent, so a device
// pointed at a branch that does not exist silently stops receiving production
// updates. Every case below is about what the header override is left holding.
describe('surfToUnlistedPr', () => {
  // A realistic baked header set: xprem-branch is declared empty at build time and
  // must be dropped when the set is rebuilt, or it would wipe server-set headers.
  const CONFIG_WITH_HEADERS = {
    ...SURF_CONFIG,
    requestHeaders: {
      'expo-app-id': 'app-id',
      'expo-channel-name': 'production',
      'xprem-branch': '',
      'xprem-surf-blocked': 'crashed-update-id',
    },
  };

  beforeEach(() => {
    config.readConfig.mockReturnValue(CONFIG_WITH_HEADERS);
  });

  it('puts the pin back on the branch that was running when nothing is servable', async () => {
    config.readLoadedState.mockReturnValue({ branch: 'pr-4792', refusedBranch: null });
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false });

    await expect(surfToUnlistedPr(9999)).resolves.toBe('not-servable');

    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenCalledTimes(2);
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenNthCalledWith(1, {
      'expo-app-id': 'app-id',
      'expo-channel-name': 'production',
      'xprem-surf-blocked': 'crashed-update-id',
      'xprem-branch': 'pr-9999',
    });
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenNthCalledWith(2, {
      'expo-app-id': 'app-id',
      'expo-channel-name': 'production',
      'xprem-surf-blocked': 'crashed-update-id',
      'xprem-branch': 'pr-4792',
    });
    expect(updates.fetchUpdateAsync).not.toHaveBeenCalled();
  });

  it('clears the override entirely when the tester was on production', async () => {
    config.readLoadedState.mockReturnValue({ branch: null, refusedBranch: null });
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false });

    await expect(surfToUnlistedPr(9999)).resolves.toBe('not-servable');

    // Not "an override carrying an empty branch" — no override at all, so the
    // native side reverts to the headers baked at build time.
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(null);
  });

  it('restores the pin and rethrows when the update check fails', async () => {
    config.readLoadedState.mockReturnValue({ branch: 'pr-4792', refusedBranch: null });
    updates.checkForUpdateAsync.mockRejectedValue(new Error('Network request failed'));

    await expect(surfToUnlistedPr(9999)).rejects.toThrow('Network request failed');

    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(
      expect.objectContaining({ 'xprem-branch': 'pr-4792' }),
    );
  });

  it('restores the pin and rethrows when the download fails', async () => {
    config.readLoadedState.mockReturnValue({ branch: null, refusedBranch: null });
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true });
    updates.fetchUpdateAsync.mockRejectedValue(new Error('Failed to download'));

    await expect(surfToUnlistedPr(9999)).rejects.toThrow('Failed to download');

    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenLastCalledWith(null);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
  });

  it('keeps the pin and reloads when the branch really is there', async () => {
    config.readLoadedState.mockReturnValue({ branch: null, refusedBranch: null });
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true });

    await expect(surfToUnlistedPr(9999)).resolves.toBe('reloading');

    expect(updates.fetchUpdateAsync).toHaveBeenCalledTimes(1);
    expect(updates.reloadAsync).toHaveBeenCalledTimes(1);
    // Pinned once, never restored — the tester is on their way to that bundle.
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenCalledTimes(1);
  });

  it('refuses a build that cannot surf without touching the headers', async () => {
    migration.isBranchSurfingBuild.mockReturnValue(false);

    await expect(surfToUnlistedPr(9999)).rejects.toThrow(BRANCH_SURFING_UNAVAILABLE_MESSAGE);

    expect(updates.setUpdateRequestHeadersOverride).not.toHaveBeenCalled();
  });

  // xprem tracks the previous pin in a module-private variable, so a restoring
  // `surfTo` would record the BOGUS branch as its own rollback target. Driving the
  // pin here is the whole design; this asserts a refactor cannot undo it.
  it('never delegates to xprem surfTo', async () => {
    config.readLoadedState.mockReturnValue({ branch: null, refusedBranch: null });
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false });

    await surfToUnlistedPr(9999);

    expect(surf.surfTo).not.toHaveBeenCalled();
  });
});
