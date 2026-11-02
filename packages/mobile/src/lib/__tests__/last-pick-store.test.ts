// @vitest-environment jsdom
// Owner decision A: the climber's last pick. The bar shows it, or the queue's
// current when THAT changed after it, whichever happened last; a pick from
// another account never shows.
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import {
  carryLastPickOverRestore,
  clearLastPick,
  getLastPick,
  lastPickClimb,
  lastPickOpenOptions,
  resetLastPickForTests,
  resolveBarPick,
  setLastPick,
  setLastPickMirrored,
  subscribeToLastPick,
  useHasLastPick,
  useLastPick,
  type LastPickInput,
} from '../last-pick-store';
import { getCredentialGeneration, invalidateCredentialSnapshots } from '../privacy/privacy-cache';

function item(uuid: string, mirrored = false): ClimbQueueItem {
  return {
    uuid: `queue-${uuid}`,
    climb: {
      uuid,
      name: `Climb ${uuid}`,
      frames: 'p1r12',
      setter_username: 'setter',
      angle: 40,
      ascensionist_count: 0,
      difficulty: 'V3',
      quality_average: '3',
      stars: 3,
      difficulty_error: '0.3',
      benchmark_difficulty: null,
      mirrored,
    },
  };
}
const track: PlaylistSuggestionSource = {
  playlistUuid: 'playlist',
  activatedClimbUuid: 'a',
  boardKey: 'kilter:1',
  climbs: [item('a').climb],
};

function input(over: Partial<LastPickInput> = {}): LastPickInput {
  return {
    item: item('a'),
    suggestionSource: track,
    commitOptions: undefined,
    mirrored: false,
    currentAtPick: 'queue-current',
    wallAtPick: 'wall',
    pickedAt: 10,
    ...over,
  };
}

beforeEach(() => {
  resetLastPickForTests();
});

describe('last pick store', () => {
  it('stores, reads and clears a pick', () => {
    const pick = input();
    setLastPick(pick);
    expect(getLastPick()).toMatchObject(pick);
    clearLastPick();
    expect(getLastPick()).toBeNull();
  });

  it('notifies only on a real change, so the bar re-renders only when its pick changes', () => {
    const pick = input();
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useLastPick();
    });
    renders = 0;
    act(() => setLastPick(pick));
    const first = result.current;
    act(() => setLastPick({ ...pick }));
    expect(result.current).toBe(first);
    expect(renders).toBe(1);
    act(() => setLastPickMirrored(false));
    expect(renders).toBe(1);
    act(() => setLastPickMirrored(true));
    expect(result.current?.mirrored).toBe(true);
    expect(renders).toBe(2);
  });

  it('answers presence only, from pick to pick', () => {
    const { result } = renderHook(() => useHasLastPick());
    expect(result.current).toBe(false);
    act(() => setLastPick(input()));
    expect(result.current).toBe(true);
    act(() => setLastPick(input({ item: item('b') })));
    expect(result.current).toBe(true);
    act(() => clearLastPick());
    expect(result.current).toBe(false);
  });

  // Sign-out or an account change: the pick belongs to the old account.
  it('hides a pick made under another account', () => {
    setLastPick(input());
    invalidateCredentialSnapshots();
    expect(getLastPick()).toBeNull();
    expect(resolveBarPick(getLastPick(), 'queue-current')).toBeNull();
  });
});

describe('resolveBarPick: the pick or the queue’s current, whichever happened last', () => {
  it('shows the pick made under the current climb', () => {
    setLastPick(input());
    expect(resolveBarPick(getLastPick(), 'queue-current')).not.toBeNull();
  });

  it('shows the queue’s current once it changed after the pick', () => {
    setLastPick(input());
    // A Put on board, a crewmate's put-up, the Lock Screen's Next, the rest timer.
    expect(resolveBarPick(getLastPick(), 'queue-next')).toBeNull();
  });

  it('shows a pick made on an empty queue while the queue stays empty', () => {
    setLastPick(input({ currentAtPick: null }));
    expect(resolveBarPick(getLastPick(), null)).not.toBeNull();
    expect(resolveBarPick(getLastPick(), 'queue-first')).toBeNull();
  });

  it('shows the current slot itself as the current climb, not as a pick', () => {
    setLastPick(input({ item: item('current'), currentAtPick: 'queue-current' }));
    expect(resolveBarPick(getLastPick(), 'queue-current')).toBeNull();
  });

  it('never shows a pick from another credential generation', () => {
    setLastPick(input());
    const stored = getLastPick();
    expect(resolveBarPick(stored, 'queue-current', getCredentialGeneration() + 1)).toBeNull();
  });
});

// Plan item 5: the cold-start restore landing is not a change after the pick.
describe('carryLastPickOverRestore', () => {
  it('carries a pick made on the still-empty queue over to the restored current', () => {
    setLastPick(input({ currentAtPick: null }));
    const notified = vi.fn();
    subscribeToLastPick(notified);
    carryLastPickOverRestore(null, 'queue-restored');
    expect(getLastPick()?.currentAtPick).toBe('queue-restored');
    expect(resolveBarPick(getLastPick(), 'queue-restored')).not.toBeNull();
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it('leaves a pick made under another current alone', () => {
    setLastPick(input({ currentAtPick: 'queue-other' }));
    const before = getLastPick();
    carryLastPickOverRestore(null, 'queue-restored');
    expect(getLastPick()).toBe(before);
  });

  it('changes nothing when the restore lands the same current, or with no pick', () => {
    carryLastPickOverRestore(null, 'queue-restored');
    expect(getLastPick()).toBeNull();
    setLastPick(input({ currentAtPick: null }));
    const before = getLastPick();
    const notified = vi.fn();
    subscribeToLastPick(notified);
    carryLastPickOverRestore(null, null);
    expect(getLastPick()).toBe(before);
    expect(notified).not.toHaveBeenCalled();
  });
});

describe('what the bar draws and how the player reopens it', () => {
  it('draws the pick with the player’s mirror flip, and the climb untouched without one', () => {
    setLastPick(input({ mirrored: true }));
    const flipped = getLastPick()!;
    expect(lastPickClimb(flipped).mirrored).toBe(true);
    expect(flipped.item.climb.mirrored).toBe(false);
    setLastPick(input({ mirrored: false }));
    const straight = getLastPick()!;
    expect(lastPickClimb(straight)).toBe(straight.item.climb);
  });

  it('reopens as the same preview: item, list, deferred commit, flip and busy-wall snapshot', () => {
    const commitOptions = { placement: 'STEP' as const };
    setLastPick(input({ commitOptions, mirrored: true }));
    expect(lastPickOpenOptions(getLastPick()!)).toEqual({
      previewQueueItem: getLastPick()!.item,
      playlistSuggestionSource: track,
      previewCommitOptions: commitOptions,
      previewMirrored: true,
      previewLatchStart: { wallClimbUuid: 'wall', at: 10 },
    });
  });

  // A logbook row's pick reopens on its own board and angle, not the active one.
  it('reopens on the board it was opened on, when that was not the active board', () => {
    const atThirty = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 30 };
    setLastPick(input({ boardConfig: atThirty }));
    expect(lastPickOpenOptions(getLastPick()!)).toMatchObject({ boardConfig: atThirty });
    setLastPick(input({ boardConfig: null }));
    expect(lastPickOpenOptions(getLastPick()!)).not.toHaveProperty('boardConfig');
  });

  it('counts the same board again as the same pick, and another angle as a new one', () => {
    const board = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 30 };
    const pick = input({ boardConfig: board });
    setLastPick(pick);
    const first = getLastPick();
    setLastPick({ ...pick, boardConfig: { ...board } });
    expect(getLastPick()).toBe(first);
    setLastPick({ ...pick, boardConfig: { ...board, angle: 35 } });
    expect(getLastPick()).not.toBe(first);
  });
});
