// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { FeatureFlagsProvider } from '../../providers/feature-flags-provider';

// Issue #2202: what `useEffectiveBoardRenderSettings` resolves to now that no
// flag is involved at all. Both board-render rollout flags were retired for
// 2.4, so the only things that answer "which drawing, which falloff" are the
// climber's own choice, the shipped default, and the capability probe — which
// is the one thing that can still override a climber outright. The precedence
// logic itself is `resolveEffectiveRenderSettings`'s contract and is pinned in
// board-render-settings.test.ts; this file proves the hook wiring.

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

vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn(), addErrorBreadcrumb: vi.fn() }));

// The settings store hydrates from AsyncStorage; the hook only reads its
// snapshot, so the suite drives that snapshot directly. `mode: 'default'`
// throughout — every case here is about what a climber who has NOT chosen a
// mode gets, which is exactly where the flag can speak.
type TestBoardRenderSettings = {
  mode: 'default' | 'classic' | 'aura';
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

  it('resolves an unchosen mode to Aura on the shipped falloff', async () => {
    const { result } = renderHook(() => useEffectiveBoardRenderSettings(), { wrapper: withFlags({}) });

    // `mode: 'default'` is the app default now, so this lands on Aura once
    // the probe confirms the binary can draw it — no flag involved any more.
    await waitFor(() => expect(result.current.effectiveRenderSettings.mode).toBe('aura'));
    expect(result.current.effectiveRenderSettings.glowFalloff).toBe('soft');
    expect(result.current.effectiveRenderSettings.glowFalloffSource).toBe('default');
  });

  it("honours the climber's own falloff pick", async () => {
    boardRenderSettingsRef.current = { mode: 'default', boardsesh: { glowFalloff: 'plateau' } };
    const { result } = renderHook(() => useEffectiveBoardRenderSettings(), { wrapper: withFlags({}) });

    await waitFor(() => expect(result.current.effectiveRenderSettings.mode).toBe('aura'));
    expect(result.current.effectiveRenderSettings.glowFalloff).toBe('plateau');
    expect(result.current.effectiveRenderSettings.glowFalloffSource).toBe('user');
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

    await waitFor(() => expect(result.current.effectiveRenderSettings.mode).toBe('aura'));
    expect(result.current.effectiveRenderSettings.glowFalloff).toBe('soft');
    expect(result.current.effectiveRenderSettings.glowFalloffSource).toBe('default');
  });

  it('ignores a stray flag value — no flag can reach the resolver any more', async () => {
    const { result } = renderHook(() => useEffectiveBoardRenderSettings(), {
      wrapper: withFlags({ 'board-glow-falloff': 'plateau' }),
    });

    // A leftover value for the retired flag, live in PostHog or in a tester's
    // overrides, must not resurrect it.
    await waitFor(() => expect(result.current.effectiveRenderSettings.mode).toBe('aura'));
    expect(result.current.effectiveRenderSettings.glowFalloff).toBe('soft');
    expect(result.current.effectiveRenderSettings.glowFalloffSource).toBe('default');
  });
});
