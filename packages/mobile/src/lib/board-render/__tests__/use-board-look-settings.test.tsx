// @vitest-environment jsdom
//
// Guards the two bugs that motivated collapsing three screens onto one writer,
// plus the reset split. All three are behaviours you cannot see in a screenshot
// and would not notice until a climber lost work.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  reset: vi.fn(),
  setMode: vi.fn(),
  rawSetBoardseshField: vi.fn(),
  resetOverrides: vi.fn(),
  rememberCustomBoardLook: vi.fn(() => Promise.resolve()),
  clearCustomBoardLook: vi.fn(() => Promise.resolve()),
  loadCustomBoardLook: vi.fn(() => Promise.resolve(null as unknown)),
  setBoardRenderSettingsPreference: vi.fn(() => Promise.resolve()),
  applyBoardLookOption: vi.fn(() => Promise.resolve()),
  trackBoardLookApplied: vi.fn(),
  settings: {
    mode: 'boardsesh' as const,
    boardsesh: {
      glowFalloff: 'default' as const,
      glowReach: 1,
      plateauShare: 0.4,
      veil: 'auto' as const,
      veilOpacity: 0.6,
      markStyle: 'glow' as const,
      fillOpacity: 0.55,
      softDisc: false,
      smallHoldBoost: true,
      ledDots: true,
      roleGlyphs: false,
      thumbnailStyle: 'fill' as const,
    },
  },
}));

vi.mock('../../board-render-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../board-render-settings')>();
  return {
    ...actual,
    useBoardRenderSettings: () => ({
      settings: mocks.settings,
      loaded: true,
      setMode: mocks.setMode,
      setBoardseshField: mocks.rawSetBoardseshField,
      reset: mocks.reset,
    }),
    setBoardRenderSettingsPreference: mocks.setBoardRenderSettingsPreference,
  };
});

vi.mock('../../../hooks/use-native-climb-render', () => ({
  useEffectiveBoardRenderSettings: () => ({
    effectiveRenderSettings: {
      mode: 'boardsesh',
      glowFalloff: 'soft',
      glowFalloffSource: 'default',
      glowStyle: 'plain',
    },
    boardseshRendererAvailable: true,
  }),
}));

vi.mock('../../../hooks/use-board-preview-climb', () => ({
  useBoardPreviewClimb: () => ({ status: 'ready', preview: null }),
}));

vi.mock('../custom-board-look', () => ({
  rememberCustomBoardLook: mocks.rememberCustomBoardLook,
  clearCustomBoardLook: mocks.clearCustomBoardLook,
  loadCustomBoardLook: mocks.loadCustomBoardLook,
}));

vi.mock('../board-look-analytics', () => ({ trackBoardLookApplied: mocks.trackBoardLookApplied }));

const { useBoardLookSettings } = await import('../use-board-look-settings');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.boardsesh.roleGlyphs = false;
});

describe('useBoardLookSettings — the one mirroring writer', () => {
  // The bug: role glyphs was wired to the RAW setter, so toggling it never
  // reached the remembered bundle. Tune a look, toggle glyphs, try a preset,
  // come back, and the glyph state was gone.
  it('remembers every field it writes, role glyphs included', async () => {
    const { result } = renderHook(() => useBoardLookSettings());

    await act(async () => {
      result.current.setBoardseshField('roleGlyphs', true);
    });

    expect(mocks.rawSetBoardseshField).toHaveBeenCalledWith('roleGlyphs', true);
    expect(mocks.rememberCustomBoardLook).toHaveBeenCalledWith(expect.objectContaining({ roleGlyphs: true }));
  });

  it('mirrors the whole bundle, not just the field that moved', async () => {
    const { result } = renderHook(() => useBoardLookSettings());

    await act(async () => {
      result.current.setBoardseshField('glowReach', 1.4);
    });

    expect(mocks.rememberCustomBoardLook).toHaveBeenCalledWith(
      expect.objectContaining({ glowReach: 1.4, veil: 'auto', markStyle: 'glow' }),
    );
  });
});

describe('useBoardLookSettings — restoring a remembered look', () => {
  // The second bug, which the first one was masking: the restore wrote the
  // bundle back raw, bypassing the merge that lets a look raise role glyphs but
  // never lower them. Harmless only while the buffer never recorded glyphs.
  it('cannot turn role glyphs off', async () => {
    mocks.settings.boardsesh.roleGlyphs = true;
    mocks.loadCustomBoardLook.mockResolvedValueOnce({
      ...mocks.settings.boardsesh,
      roleGlyphs: false,
    });

    const { result } = renderHook(() => useBoardLookSettings());
    await act(async () => {
      await result.current.restoreCustomLook();
    });

    expect(mocks.setBoardRenderSettingsPreference).toHaveBeenCalledWith(
      expect.objectContaining({ boardsesh: expect.objectContaining({ roleGlyphs: true }) }),
    );
  });

  it('can still turn role glyphs on', async () => {
    mocks.settings.boardsesh.roleGlyphs = false;
    mocks.loadCustomBoardLook.mockResolvedValueOnce({
      ...mocks.settings.boardsesh,
      roleGlyphs: true,
    });

    const { result } = renderHook(() => useBoardLookSettings());
    await act(async () => {
      await result.current.restoreCustomLook();
    });

    expect(mocks.setBoardRenderSettingsPreference).toHaveBeenCalledWith(
      expect.objectContaining({ boardsesh: expect.objectContaining({ roleGlyphs: true }) }),
    );
  });

  it('merges against the settings as they are when the read lands, not a render ago', async () => {
    // `loadCustomBoardLook` is async. If the merge reads the bundle captured when
    // the callback was built, a change made while that read is in flight gets
    // merged away — and the accessibility fields this merge exists to protect are
    // exactly what would be dropped.
    //
    // The whole settings OBJECT is replaced rather than mutated, because that is
    // what a real state update does. Mutating the existing one in place is
    // visible through a stale closure too, so it cannot tell the two apart.
    mocks.settings = { ...mocks.settings, boardsesh: { ...mocks.settings.boardsesh, roleGlyphs: false } };

    let releaseRead: (value: (typeof mocks.settings)['boardsesh']) => void = () => {};
    mocks.loadCustomBoardLook.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseRead = resolve;
      }),
    );

    const { result, rerender } = renderHook(() => useBoardLookSettings());
    let restored: Promise<void> = Promise.resolve();
    act(() => {
      restored = result.current.restoreCustomLook();
    });

    // The climber turns role glyphs on while the storage read is still in flight.
    mocks.settings = { ...mocks.settings, boardsesh: { ...mocks.settings.boardsesh, roleGlyphs: true } };
    rerender();

    await act(async () => {
      releaseRead({ ...mocks.settings.boardsesh, roleGlyphs: false });
      await restored;
    });

    expect(mocks.setBoardRenderSettingsPreference).toHaveBeenCalledWith(
      expect.objectContaining({ boardsesh: expect.objectContaining({ roleGlyphs: true }) }),
    );
  });

  it('writes nothing when there is no remembered look', async () => {
    mocks.loadCustomBoardLook.mockResolvedValueOnce(null);

    const { result } = renderHook(() => useBoardLookSettings());
    await act(async () => {
      await result.current.restoreCustomLook();
    });

    expect(mocks.setBoardRenderSettingsPreference).not.toHaveBeenCalled();
  });
});

describe('useBoardLookSettings — mirroring a field change', () => {
  it('carries a second change made in the same tick on top of the first', () => {
    // The store write is async, so two changes made before React re-renders both
    // saw the same pre-change bundle and the second dropped the first from the
    // remembered look — the look you come back to would be missing a knob you set.
    const { result } = renderHook(() => useBoardLookSettings());

    act(() => {
      result.current.setBoardseshField('roleGlyphs', true);
      result.current.setBoardseshField('softDisc', true);
    });

    expect(mocks.rememberCustomBoardLook).toHaveBeenLastCalledWith(
      expect.objectContaining({ roleGlyphs: true, softDisc: true }),
    );
  });

  it('still writes the field through to the settings store', () => {
    const { result } = renderHook(() => useBoardLookSettings());

    act(() => {
      result.current.setBoardseshField('roleGlyphs', true);
    });

    expect(mocks.rawSetBoardseshField).toHaveBeenCalledWith('roleGlyphs', true);
  });
});

describe('useBoardLookSettings — the reset split', () => {
  // "Reset board look" used to also wipe hold colours, shapes, brush and size —
  // state set on another screen that drives the physical board's LEDs, under a
  // label that never mentioned it.
  it('clears the render settings and the remembered look, and nothing else', async () => {
    const { result } = renderHook(() => useBoardLookSettings());

    await act(async () => {
      result.current.resetBoardLook();
    });

    expect(mocks.reset).toHaveBeenCalledTimes(1);
    expect(mocks.clearCustomBoardLook).toHaveBeenCalledTimes(1);
    expect(mocks.resetOverrides).not.toHaveBeenCalled();
  });
});
