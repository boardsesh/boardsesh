// @vitest-environment jsdom
// Owner decision A: the last pick ends when the queue's current changes after
// it, when the climber changes board, and on sign-out or an account change.
// The one change of current it outlives is the cold-start queue restore's.
import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';

const state = vi.hoisted(() => ({
  current: null as { uuid: string } | null,
  restored: true,
  boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 } as {
    boardName: string;
    layoutId: number;
    sizeId: number;
    setIds: string;
    angle: number;
  } | null,
}));

vi.mock('../../../providers/queue-provider', () => ({
  useQueueData: () => ({ currentClimbQueueItem: state.current }),
  useQueueRestored: () => state.restored,
}));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ boardConfig: state.boardConfig }),
}));

import { LastPickWatcher, lastPickChange } from '../LastPickWatcher';
import {
  getLastPick,
  hasStoredLastPick,
  resetLastPickForTests,
  resolveBarPick,
  setLastPick,
  subscribeToLastPick,
} from '../../../lib/last-pick-store';
import { invalidateCredentialSnapshots } from '../../../lib/privacy/privacy-cache';

function pickItem(): ClimbQueueItem {
  return {
    uuid: 'queue-pick',
    climb: {
      uuid: 'pick',
      name: 'Pick',
      frames: '',
      setter_username: 'setter',
      angle: 40,
      ascensionist_count: 0,
      difficulty: 'V3',
      quality_average: '3',
      stars: 3,
      difficulty_error: '0.3',
      benchmark_difficulty: null,
    },
  };
}

function pick() {
  setLastPick({
    item: pickItem(),
    suggestionSource: null,
    commitOptions: undefined,
    mirrored: false,
    currentAtPick: state.current?.uuid ?? null,
    wallAtPick: null,
    pickedAt: 0,
  });
}

beforeEach(() => {
  resetLastPickForTests();
  state.current = { uuid: 'queue-current' };
  state.restored = true;
  state.boardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };
});

describe('LastPickWatcher', () => {
  it('keeps the pick while nothing it watches changes', () => {
    const view = render(createElement(LastPickWatcher));
    pick();
    view.rerender(createElement(LastPickWatcher));
    expect(getLastPick()).not.toBeNull();
  });

  // A Put on board, a crewmate's put-up, the Lock Screen's Next, the rest timer.
  it('ends the pick when the queue’s current changes', () => {
    const view = render(createElement(LastPickWatcher));
    pick();
    state.current = { uuid: 'queue-next' };
    view.rerender(createElement(LastPickWatcher));
    expect(getLastPick()).toBeNull();
  });

  it('ends the pick on a change of board, but not of angle', () => {
    const view = render(createElement(LastPickWatcher));
    pick();
    state.boardConfig = { ...state.boardConfig!, angle: 45 };
    view.rerender(createElement(LastPickWatcher));
    expect(getLastPick()).not.toBeNull();
    state.boardConfig = { ...state.boardConfig!, boardName: 'tension', layoutId: 9 };
    view.rerender(createElement(LastPickWatcher));
    expect(getLastPick()).toBeNull();
  });

  // The stored active board is read from storage after launch, so a pick from
  // a notification can land first. Its arrival is not a change of board.
  it('keeps the pick when the stored board arrives after it', () => {
    state.boardConfig = null;
    const view = render(createElement(LastPickWatcher));
    pick();
    state.boardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };
    view.rerender(createElement(LastPickWatcher));
    expect(getLastPick()).not.toBeNull();
    // Once there, a change of board still ends it.
    state.boardConfig = { ...state.boardConfig, boardName: 'tension', layoutId: 9 };
    view.rerender(createElement(LastPickWatcher));
    expect(getLastPick()).toBeNull();
  });

  it('ends the pick when the board goes away', () => {
    const view = render(createElement(LastPickWatcher));
    pick();
    state.boardConfig = null;
    view.rerender(createElement(LastPickWatcher));
    expect(getLastPick()).toBeNull();
  });

  it('ends the pick on sign-out or an account change', () => {
    render(createElement(LastPickWatcher));
    pick();
    act(() => invalidateCredentialSnapshots());
    // Cleared from the store, not just hidden: `getLastPick` already hides
    // another account's pick by itself, so only the raw read can tell that the
    // watcher dropped it (a hidden one would keep an empty accessory mounted).
    expect(hasStoredLastPick()).toBe(false);
    expect(getLastPick()).toBeNull();
    pick();
    expect(getLastPick()).not.toBeNull();
  });
});

// Plan item 5: a pick made from a notification or a link while the saved queue
// was still loading. The restore landing changes the current, but the climber
// didn't, so the pick stays and the bar keeps showing it.
describe('LastPickWatcher across the cold-start queue restore', () => {
  function launchBeforeRestore() {
    state.current = null;
    state.restored = false;
    const view = render(createElement(LastPickWatcher));
    pick();
    return view;
  }

  function restoreLands(current: { uuid: string } | null, view: ReturnType<typeof render>) {
    state.current = current;
    state.restored = true;
    view.rerender(createElement(LastPickWatcher));
  }

  it('keeps a pick made before the restore, and the bar keeps showing it', () => {
    const view = launchBeforeRestore();
    restoreLands({ uuid: 'queue-restored' }, view);
    const kept = getLastPick();
    expect(kept?.item.uuid).toBe('queue-pick');
    // Carried over to the restored current, so the bar reads it as the newest.
    expect(kept?.currentAtPick).toBe('queue-restored');
    expect(resolveBarPick(kept, 'queue-restored')).toBe(kept);
  });

  it('still ends the pick on a real change after the restore', () => {
    const view = launchBeforeRestore();
    restoreLands({ uuid: 'queue-restored' }, view);
    state.current = { uuid: 'queue-next' };
    view.rerender(createElement(LastPickWatcher));
    expect(getLastPick()).toBeNull();
  });

  it('changes nothing when the restore lands the same current', () => {
    state.current = { uuid: 'queue-current' };
    state.restored = false;
    const view = render(createElement(LastPickWatcher));
    pick();
    const before = getLastPick();
    const notified = vi.fn();
    const unsubscribe = subscribeToLastPick(notified);
    restoreLands({ uuid: 'queue-current' }, view);
    unsubscribe();
    expect(getLastPick()).toBe(before);
    expect(notified).not.toHaveBeenCalled();
  });

  it('changes nothing when the restore brings back no current', () => {
    const view = launchBeforeRestore();
    const before = getLastPick();
    restoreLands(null, view);
    expect(getLastPick()).toBe(before);
  });

  // The restore's render must be seen even when the current doesn't move, or
  // the next put-up would read as the restore and carry a stale pick.
  it('ends the pick on the first put-up after a restore that brought nothing back', () => {
    const view = launchBeforeRestore();
    restoreLands(null, view);
    state.current = { uuid: 'queue-put-up' };
    view.rerender(createElement(LastPickWatcher));
    expect(getLastPick()).toBeNull();
  });

  // Cold start: the board read from storage lands after the pick, then the
  // saved queue lands. Neither is the climber's change.
  it('keeps a pick made before the stored board and the restore both land', () => {
    state.boardConfig = null;
    const view = launchBeforeRestore();
    state.boardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };
    view.rerender(createElement(LastPickWatcher));
    restoreLands({ uuid: 'queue-restored' }, view);
    expect(getLastPick()?.currentAtPick).toBe('queue-restored');
  });

  it('ends the pick when the current changes before the restore lands', () => {
    const view = launchBeforeRestore();
    // Not the restore: it is still loading.
    state.current = { uuid: 'queue-put-up' };
    view.rerender(createElement(LastPickWatcher));
    expect(getLastPick()).toBeNull();
  });

  it('ends the pick when the restore lands together with a change of board', () => {
    const view = launchBeforeRestore();
    state.boardConfig = { ...state.boardConfig!, boardName: 'tension', layoutId: 9 };
    restoreLands({ uuid: 'queue-restored' }, view);
    expect(getLastPick()).toBeNull();
  });
});

describe('lastPickChange', () => {
  const base = { currentItemUuid: 'a', boardKey: 'kilter:1:10:1,2', generation: 1, restored: true };
  const loading = { ...base, currentItemUuid: null, restored: false };
  it.each([
    ['nothing changed', base, base, 'keeps'],
    ['the current changed', base, { ...base, currentItemUuid: 'b' }, 'ends'],
    ['the current went away', base, { ...base, currentItemUuid: null }, 'ends'],
    ['the board changed', base, { ...base, boardKey: 'tension:9:1:1' }, 'ends'],
    ['the stored board arrived', { ...base, boardKey: null }, base, 'keeps'],
    ['the board went away', base, { ...base, boardKey: null }, 'ends'],
    [
      'the stored board arrived as the current changed',
      { ...base, boardKey: null },
      { ...base, currentItemUuid: 'b' },
      'ends',
    ],
    [
      'the stored board arrived with the restore',
      { ...loading, boardKey: null },
      { ...loading, currentItemUuid: 'r', restored: true },
      'carries',
    ],
    ['the account changed', base, { ...base, generation: 2 }, 'ends'],
    [
      'the restore landed a current on the empty queue',
      loading,
      { ...loading, currentItemUuid: 'r', restored: true },
      'carries',
    ],
    ['the restore landed without a current', loading, { ...loading, restored: true }, 'keeps'],
    [
      'a first climb went up after the restore brought none back',
      { ...loading, restored: true },
      { ...loading, currentItemUuid: 'b', restored: true },
      'ends',
    ],
    ['the current changed while the restore loads', loading, { ...loading, currentItemUuid: 'b' }, 'ends'],
    [
      'the restore flag turned with a current already there',
      { ...base, restored: false },
      { ...base, currentItemUuid: 'b' },
      'ends',
    ],
    ['the restore landed with a change of board', loading, { ...base, boardKey: 'tension:9:1:1' }, 'ends'],
  ] as const)('%s', (_label, previous, next, change) => {
    expect(lastPickChange(previous, next)).toBe(change);
  });
});
