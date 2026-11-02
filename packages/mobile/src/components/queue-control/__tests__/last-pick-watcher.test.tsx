// @vitest-environment jsdom
// Owner decision A: the last pick ends when the queue's current changes after
// it, when the climber changes board, and on sign-out or an account change.
import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';

const state = vi.hoisted(() => ({
  current: null as { uuid: string } | null,
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
}));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ boardConfig: state.boardConfig }),
}));

import { LastPickWatcher, lastPickEnds } from '../LastPickWatcher';
import { getLastPick, hasStoredLastPick, resetLastPickForTests, setLastPick } from '../../../lib/last-pick-store';
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

describe('lastPickEnds', () => {
  const base = { currentItemUuid: 'a', boardKey: 'kilter:1:10:1,2', generation: 1 };
  it.each([
    ['nothing changed', base, false],
    ['the current changed', { ...base, currentItemUuid: 'b' }, true],
    ['the current went away', { ...base, currentItemUuid: null }, true],
    ['the board changed', { ...base, boardKey: 'tension:9:1:1' }, true],
    ['the account changed', { ...base, generation: 2 }, true],
  ] as const)('%s', (_label, next, ends) => {
    expect(lastPickEnds(base, next)).toBe(ends);
  });
});
