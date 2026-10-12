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
type CallbackOptions = NonNullable<Parameters<Mutate>[1]>;
type SuccessResponse = Parameters<NonNullable<CallbackOptions['onSuccess']>>[0];
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

  it('optimistically toggles the real server state, then reconciles the returned truth', () => {
    const initial = { ...options(), serverFavorited: true };
    const { result } = renderHook(() => usePlayFavorite(initial));
    expect(result.current.isFavorited).toBe(true);
    act(() => result.current.handleToggleFavorite());
    expect(result.current.isFavorited).toBe(false);
    const [variables, callbacks] = initial.toggleFavoriteMutate.mock.calls[0];
    expect(variables).toEqual({
      input: { boardName: 'kilter', climbUuid: 'climb-a', angle: 40 },
      currentlyFavorited: true,
    });
    expect(effects.track).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: 'removed', climbUuid: 'climb-a', layoutId: 1, source: 'mobile_play_drawer' }),
    );
    act(() =>
      callbacks?.onSuccess?.(
        { toggleFavorite: { favorited: true } } as SuccessResponse,
        variables,
        undefined,
        {} as never,
      ),
    );
    expect(result.current.isFavorited).toBe(true);
    expect(effects.hapticSelection).not.toHaveBeenCalled();
  });

  it('rolls back only its own optimistic state and keeps menu haptics', () => {
    const initial = options();
    const { result } = renderHook(() => usePlayFavorite(initial));
    act(() => result.current.handleToggleFavoriteFromMenu());
    expect(result.current.isFavorited).toBe(true);
    expect(effects.hapticSelection).toHaveBeenCalledOnce();
    act(() => result.current.handleToggleFavorite());
    expect(result.current.isFavorited).toBe(false);
    act(() => errorFor(initial.toggleFavoriteMutate, 0));
    expect(result.current.isFavorited).toBe(false);
    expect(initial.showToast).toHaveBeenCalledWith('playView.favoriteError', 'error');
  });

  // The heart and ⋯'s row are one toggle, but two places to tap it.
  it('tells a menu tap from a heart tap in the FavoriteToggle source', () => {
    const { result } = renderHook(() => usePlayFavorite(options()));
    act(() => result.current.handleToggleFavoriteFromMenu());
    expect(effects.track).toHaveBeenLastCalledWith(
      'Favorite Toggle',
      expect.objectContaining({ action: 'added', source: 'play_drawer_menu' }),
    );
    act(() => result.current.handleToggleFavorite());
    expect(effects.track).toHaveBeenLastCalledWith(
      'Favorite Toggle',
      expect.objectContaining({ action: 'removed', source: 'mobile_play_drawer' }),
    );
  });

  it('exposes a stable reset for the existing climb-change effect and explicit same-climb reopen', () => {
    const initial = options();
    const { result, rerender } = renderHook((props) => usePlayFavorite(props), { initialProps: initial });
    const reset = result.current.resetFavoriteOverride;
    act(() => result.current.handleToggleFavorite());
    expect(result.current.isFavorited).toBe(true);
    act(() => result.current.resetFavoriteOverride());
    expect(result.current.isFavorited).toBe(false);
    act(() => errorFor(initial.toggleFavoriteMutate, 0));
    expect(result.current.isFavorited).toBe(false);
    rerender({ ...initial, displayedClimb: { ...climb, uuid: 'climb-b' }, serverFavorited: true });
    expect(result.current.resetFavoriteOverride).toBe(reset);
    act(() => result.current.resetFavoriteOverride());
    expect(result.current.isFavorited).toBe(true);
  });
});
