// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { FeatureFlagsProvider } from '../../providers/feature-flags-provider';

// PR E (issue #2202): wiring the `board-render-mode-default` /
// `board-glow-falloff` rollout flags into the resolver. The precedence logic
// itself (flag vs user vs renderer) is `resolveEffectiveRenderSettings`'s own
// contract and is pinned in board-render-settings.test.ts — this file proves
// the WIRING: that `useEffectiveBoardRenderSettings` actually reads the two
// live flags (via FeatureFlagsProvider) instead of passing `undefined`.

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

  it('resolves boardsesh with glowFalloffSource "flag" when the flag says boardsesh and the climber has not chosen', async () => {
    const { result } = renderHook(() => useEffectiveBoardRenderSettings(), {
      wrapper: withFlags({ 'board-render-mode-default': 'boardsesh', 'board-glow-falloff': 'plateau' }),
    });

    await waitFor(() => expect(result.current.effectiveRenderSettings.mode).toBe('boardsesh'));
    expect(result.current.effectiveRenderSettings.glowFalloff).toBe('plateau');
    expect(result.current.effectiveRenderSettings.glowFalloffSource).toBe('flag');
  });

  it("lets the climber's own classic choice beat the flag", async () => {
    boardRenderSettingsRef.current = { mode: 'classic', boardsesh: { glowFalloff: 'default' } };
    const { result } = renderHook(() => useEffectiveBoardRenderSettings(), {
      wrapper: withFlags({ 'board-render-mode-default': 'boardsesh' }),
    });

    // Give any async probe a tick to (not) resolve, then assert it stayed classic.
    await Promise.resolve();
    expect(result.current.effectiveRenderSettings.mode).toBe('classic');
  });

  it('forces classic when the installed renderer cannot draw the mode, even with the flag on', async () => {
    nativeModule.probeBoardseshRendererSupport.mockResolvedValue(false);
    const { result } = renderHook(() => useEffectiveBoardRenderSettings(), {
      wrapper: withFlags({ 'board-render-mode-default': 'boardsesh' }),
    });

    await waitFor(() => expect(result.current.boardseshRendererAvailable).toBe(false));
    expect(result.current.effectiveRenderSettings.mode).toBe('classic');
  });

  it('reads the plain shipped defaults when the flags are unresolved', () => {
    const { result } = renderHook(() => useEffectiveBoardRenderSettings(), { wrapper: withFlags({}) });
    expect(result.current.effectiveRenderSettings.mode).toBe('classic');
    expect(result.current.effectiveRenderSettings.glowFalloff).toBe('soft');
    expect(result.current.effectiveRenderSettings.glowFalloffSource).toBe('default');
  });

  it('ignores a variant flag value outside the declared set', () => {
    const { result } = renderHook(() => useEffectiveBoardRenderSettings(), {
      wrapper: withFlags({ 'board-render-mode-default': 'not-a-real-variant' }),
    });
    expect(result.current.effectiveRenderSettings.mode).toBe('classic');
  });
});
