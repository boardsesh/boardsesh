// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { createInstance } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import type { PlayCoreEnhancementSnapshot } from '../PlayCoreEnhancements';
import { usePlayFavorite } from '../use-play-favorite';

const effects = vi.hoisted(() => ({ track: vi.fn(), hapticSelection: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: effects.track }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: effects.hapticSelection }));

type Mutate = PlayCoreEnhancementSnapshot['toggleFavoriteMutate'];
const climb: Climb = {
  uuid: 'climb-a',
  name: 'Climb A',
  setter_username: 'setter',
  frames: 'p1r1',
  angle: 40,
  ascensionist_count: 10,
  difficulty: '6b',
  quality_average: '3',
  stars: 3,
  difficulty_error: '0',
  benchmark_difficulty: null,
};
const translations = createInstance();
void translations.init({ lng: 'en', resources: { en: { session: {} } }, initAsync: false });
const t = translations.getFixedT(null, 'session');

function options() {
  return {
    displayedClimb: climb,
    boardName: 'kilter',
    layoutId: 1,
    angle: 40,
    bluetoothConnected: false,
    serverFavorited: false,
    toggleFavoriteMutate: vi.fn<Mutate>(),
    showToast: vi.fn(),
    t,
  };
}

function errorFor(mutate: ReturnType<typeof vi.fn<Mutate>>, index: number) {
  const [variables, callbacks] = mutate.mock.calls[index];
  callbacks?.onError?.(new Error('Mutation failed'), variables, undefined, {} as never);
}

beforeEach(() => vi.clearAllMocks());

describe('usePlayFavorite', () => {
  it('does nothing until the deferred scoped delegate exists', () => {
    const { result } = renderHook(() => usePlayFavorite({ ...options(), toggleFavoriteMutate: undefined }));
    act(() => result.current.handleToggleFavorite());
    expect(result.current.isFavorited).toBe(false);
    expect(effects.track).not.toHaveBeenCalled();
  });

  it('toggles from the shared cache entry and leaves the flip to the toggle', () => {
    const initial = { ...options(), serverFavorited: true };
    const { result } = renderHook(() => usePlayFavorite(initial));
    expect(result.current.isFavorited).toBe(true);
    act(() => result.current.handleToggleFavorite());
    const [variables] = initial.toggleFavoriteMutate.mock.calls[0];
    // The toggle tracks the tap, in the direction it really goes.
    expect(variables).toEqual({
      input: { boardName: 'kilter', climbUuid: 'climb-a', angle: 40 },
      currentlyFavorited: true,
      tracking: { source: 'mobile_play_drawer', layoutId: 1, connected: false },
    });
    expect(effects.track).not.toHaveBeenCalled();
    // No local copy: the heart moves only when the cache does.
    expect(result.current.isFavorited).toBe(true);
    expect(effects.hapticSelection).not.toHaveBeenCalled();
  });

  // The MiniPlayer's heart writes the same cache entry (#6940).
  it('draws whatever the cache entry says, whoever moved it', () => {
    const initial = options();
    const { result, rerender } = renderHook((props) => usePlayFavorite(props), { initialProps: initial });
    act(() => result.current.handleToggleFavorite());
    rerender({ ...initial, serverFavorited: true });
    expect(result.current.isFavorited).toBe(true);
    rerender({ ...initial, serverFavorited: false });
    expect(result.current.isFavorited).toBe(false);
  });

  it('says so when the toggle fails, and keeps the menu haptic', () => {
    const initial = options();
    const { result } = renderHook(() => usePlayFavorite(initial));
    act(() => result.current.handleToggleFavoriteFromMenu());
    expect(effects.hapticSelection).toHaveBeenCalledOnce();
    act(() => errorFor(initial.toggleFavoriteMutate, 0));
    expect(initial.showToast).toHaveBeenCalledWith('playView.favoriteError', 'error');
  });

  it('tags heart and menu toggles with this phone’s current connection', () => {
    const initial = options();
    const { result, rerender } = renderHook((props) => usePlayFavorite(props), { initialProps: initial });
    const lastTracking = () => initial.toggleFavoriteMutate.mock.calls.at(-1)?.[0].tracking;
    act(() => result.current.handleToggleFavorite());
    expect(lastTracking()).toMatchObject({ connected: false });
    rerender({ ...initial, bluetoothConnected: true });
    act(() => result.current.handleToggleFavoriteFromMenu());
    expect(lastTracking()).toMatchObject({ connected: true });
  });

  // The heart and ⋯'s row are one toggle, but two places to tap it.
  it('tells a menu tap from a heart tap in the FavoriteToggle source', () => {
    const initial = options();
    const { result, rerender } = renderHook((props) => usePlayFavorite(props), { initialProps: initial });
    const lastCall = () => initial.toggleFavoriteMutate.mock.calls.at(-1)?.[0];
    act(() => result.current.handleToggleFavoriteFromMenu());
    expect(lastCall()).toMatchObject({ currentlyFavorited: false, tracking: { source: 'play_drawer_menu' } });
    rerender({ ...initial, serverFavorited: true });
    act(() => result.current.handleToggleFavorite());
    expect(lastCall()).toMatchObject({ currentlyFavorited: true, tracking: { source: 'mobile_play_drawer' } });
  });
});
