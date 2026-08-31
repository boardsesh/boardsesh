// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { FeatureFlagsProvider } from '../../providers/feature-flags-provider';

// Issue #2202: wiring the `board-glow-falloff` rollout flag into the resolver,
// and what a climber who has NOT chosen a mode now resolves to. The precedence
// logic itself (flag vs user vs renderer) is `resolveEffectiveRenderSettings`'s
// own contract and is pinned in board-render-settings.test.ts — this file proves
// the WIRING: that `useEffectiveBoardRenderSettings` actually reads the live
// flag (via FeatureFlagsProvider) instead of passing `undefined`.
//
// The mode half no longer has a flag: 2.4 retired `board-render-mode-default`
// and made the Boardsesh drawing the app default, so the only things that can
// still answer "which drawing" are the climber's own choice and the capability
// probe. Both are covered below.

vi.mock('../../providers/theme-provider', () => ({
  useAppColorScheme: () => 'light',
}));

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(() => ({ exists: false, list: () => [] })),
  File: vi.fn(() => ({ exists: false })),
  Paths: { cache: { uri: 'file:///cache/' } },
}));

vi.mock('../../lib/board-details', () => ({ getBoardRenderData: vi.fn(() => null) }));

vi.mock('../../lib/background-image-cache', () => ({
  tryGetBackgroundPathsSync: vi.fn(() => ({ paths: [], missingCount: 0 })),
  ensureBackgroundsCached: vi.fn(async () => ({ paths: [], missingCount: 0 })),
}));

vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn() }));

// The settings store hydrates from AsyncStorage; the hook only reads its
// snapshot, so the suite drives that snapshot directly. `mode: 'default'`
// throughout — every case here is about what a climber who has NOT chosen a
// mode gets, which is exactly where the flag can speak.
type TestBoardRenderSettings = {
  mode: 'default' | 'classic' | 'boardsesh';
  boardsesh: { glowFalloff: 'default' | 'soft' | 'plateau' };
};
const boardRenderSettingsRef = vi.hoisted<{ current: TestBoardRenderSettings }>(() => ({
  current: { mode: 'default', boardsesh: { glowFalloff: 'default' } },
}));
vi.mock('../../lib/board-render-settings', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/board-render-settings')>();
  return {
    ...original,
    useBoardRenderSettings: () => ({
      settings: { ...original.DEFAULT_BOARD_RENDER_SETTINGS, ...boardRenderSettingsRef.current },
      loaded: true,
      setMode: () => {},
      setBoardseshField: () => {},
      reset: () => {},
    }),
  };
});

const { useEffectiveBoardRenderSettings, _resetBoardseshSupportForTests, _setNativeModuleForTests } =
  await import('../use-native-climb-render');

function withFlags(flags: Record<string, boolean | string>) {
  return ({ children }: { children: ReactNode }) => (
    <FeatureFlagsProvider flags={flags}>{children}</FeatureFlagsProvider>
  );
}

describe('useEffectiveBoardRenderSettings — flag wiring', () => {
  const nativeModule = { boardRendererNative: {}, probeBoardseshRendererSupport: vi.fn<() => Promise<boolean>>() };

  beforeEach(() => {
    _resetBoardseshSupportForTests();
    boardRenderSettingsRef.current = { mode: 'default', boardsesh: { glowFalloff: 'default' } };
    nativeModule.probeBoardseshRendererSupport.mockReset();
    nativeModule.probeBoardseshRendererSupport.mockResolvedValue(true);
    _setNativeModuleForTests(nativeModule as unknown as Parameters<typeof _setNativeModuleForTests>[0]);
  });

  it('reads the live glow-falloff flag, and resolves an unchosen mode to Boardsesh', async () => {
    const { result } = renderHook(() => useEffectiveBoardRenderSettings(), {
      wrapper: withFlags({ 'board-glow-falloff': 'plateau' }),
    });

    // `mode: 'default'` is the app default now, so this lands on Boardsesh once
    // the probe confirms the binary can draw it — no flag involved.
    await waitFor(() => expect(result.current.effectiveRenderSettings.mode).toBe('boardsesh'));
    expect(result.current.effectiveRenderSettings.glowFalloff).toBe('plateau');
    expect(result.current.effectiveRenderSettings.glowFalloffSource).toBe('flag');
  });

  it("lets the climber's own classic choice beat the app default", async () => {
    boardRenderSettingsRef.current = { mode: 'classic', boardsesh: { glowFalloff: 'default' } };
    const { result } = renderHook(() => useEffectiveBoardRenderSettings(), { wrapper: withFlags({}) });

    // Give any async probe a tick to (not) resolve, then assert it stayed classic.
    await Promise.resolve();
    expect(result.current.effectiveRenderSettings.mode).toBe('classic');
  });

  it('forces classic when the installed renderer cannot draw the mode', async () => {
    // With the rollout flag gone this probe is the ONLY thing standing between
    // an older binary and a drawing it cannot produce.
    nativeModule.probeBoardseshRendererSupport.mockResolvedValue(false);
    const { result } = renderHook(() => useEffectiveBoardRenderSettings(), { wrapper: withFlags({}) });

    await waitFor(() => expect(result.current.boardseshRendererAvailable).toBe(false));
    expect(result.current.effectiveRenderSettings.mode).toBe('classic');
  });

  it('reads the shipped falloff default when the flag is unresolved', async () => {
    const { result } = renderHook(() => useEffectiveBoardRenderSettings(), { wrapper: withFlags({}) });

    await waitFor(() => expect(result.current.effectiveRenderSettings.mode).toBe('boardsesh'));
    expect(result.current.effectiveRenderSettings.glowFalloff).toBe('soft');
    expect(result.current.effectiveRenderSettings.glowFalloffSource).toBe('default');
  });

  it('ignores a variant flag value outside the declared set', async () => {
    const { result } = renderHook(() => useEffectiveBoardRenderSettings(), {
      wrapper: withFlags({ 'board-glow-falloff': 'not-a-real-variant' }),
    });

    await waitFor(() => expect(result.current.effectiveRenderSettings.mode).toBe('boardsesh'));
    expect(result.current.effectiveRenderSettings.glowFalloff).toBe('soft');
    expect(result.current.effectiveRenderSettings.glowFalloffSource).toBe('default');
  });
});
