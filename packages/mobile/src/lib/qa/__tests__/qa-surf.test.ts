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
}));
// `__DEV__` is substituted textually by both Metro and Vitest, so the dev branch
// can only be exercised through this helper — which is exactly why qa-surf
// delegates to it instead of testing `__DEV__` itself.
const migration = vi.hoisted(() => ({ isBranchSurfingBuild: vi.fn(() => true) }));

vi.mock('@xprem/control-center/src/surf', () => ({
  listBranches: surf.listBranches,
  surfTo: surf.surfTo,
}));
vi.mock('@xprem/control-center/src/config', () => ({
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
    updates.manifest = { extra: { branch: 'release-next' } };
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
        { name: 'release/next-ota', lastUpdateAt: '2026-08-24T10:00:00.000Z' },
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
    expect(surf.listBranches).toHaveBeenCalledWith(SURF_CONFIG, controller.signal);
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
