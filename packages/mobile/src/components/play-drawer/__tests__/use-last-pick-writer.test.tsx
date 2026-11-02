// @vitest-environment jsdom
// Owner decision A: the player is the one writer of the climber's last pick.
// An open writes once (a pane's replay never does), every later change of
// what the player shows writes again, and a committed climb ends the pick.
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

vi.mock('../../../lib/privacy/privacy-cache', () => ({ getCredentialGeneration: () => 7 }));

import { getLastPick, resetLastPickForTests, setLastPick } from '../../../lib/last-pick-store';
import { pickBoardOverride, useLastPickWriter, type LastPickWriterInputs } from '../use-last-pick-writer';
import type { AppliedPlayerOpen } from '../use-play-selection-controller';

function item(uuid: string): ClimbQueueItem {
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
    },
  };
}
const track: PlaylistSuggestionSource = {
  playlistUuid: 'playlist',
  activatedClimbUuid: 'a',
  boardKey: 'kilter:1',
  climbs: [item('a').climb, item('b').climb],
};

function writerInputs(over: Partial<LastPickWriterInputs> = {}): LastPickWriterInputs {
  return {
    enabled: true,
    previewItem: null,
    previewSuggestionSource: null,
    previewMirrored: false,
    getCommitOptions: () => undefined,
    getCurrentItemUuid: () => 'queue-current',
    getLatchStart: () => ({ wallClimbUuid: 'wall', at: 100 }),
    ...over,
  };
}

function applied(over: Partial<AppliedPlayerOpen> = {}): AppliedPlayerOpen {
  return {
    previewItem: null,
    suggestionSource: null,
    commitOptions: undefined,
    mirrored: false,
    replay: false,
    latchStart: undefined,
    putOnBoard: false,
    ...over,
  };
}

beforeEach(() => {
  resetLastPickForTests();
});

describe('useLastPickWriter', () => {
  it('records a fresh preview open as the pick, with the current climb it was made under', () => {
    const preview = item('a');
    const { result } = renderHook((props: LastPickWriterInputs) => useLastPickWriter(props), {
      initialProps: writerInputs(),
    });
    act(() => result.current.noteOpenApplied(applied({ previewItem: preview, suggestionSource: track })));
    expect(getLastPick()).toMatchObject({
      item: preview,
      suggestionSource: track,
      currentAtPick: 'queue-current',
      wallAtPick: 'wall',
      pickedAt: 100,
    });
  });

  it('keeps a reopened pick’s busy-wall snapshot rather than the wall at the reopen', () => {
    const preview = item('a');
    const { result } = renderHook((props: LastPickWriterInputs) => useLastPickWriter(props), {
      initialProps: writerInputs(),
    });
    act(() =>
      result.current.noteOpenApplied(
        applied({ previewItem: preview, latchStart: { wallClimbUuid: 'wall-then', at: 5 } }),
      ),
    );
    expect(getLastPick()).toMatchObject({ wallAtPick: 'wall-then', pickedAt: 5 });
  });

  it('never records a pane’s replay, nor the replayed state landing', () => {
    const preview = item('a');
    const { result, rerender } = renderHook((props: LastPickWriterInputs) => useLastPickWriter(props), {
      initialProps: writerInputs(),
    });
    act(() => result.current.noteOpenApplied(applied({ previewItem: preview, replay: true })));
    rerender(writerInputs({ previewItem: preview }));
    expect(getLastPick()).toBeNull();
  });

  it('writes the open once: its state landing a render later is not a second pick', () => {
    const preview = item('a');
    const { result, rerender } = renderHook((props: LastPickWriterInputs) => useLastPickWriter(props), {
      initialProps: writerInputs(),
    });
    act(() => result.current.noteOpenApplied(applied({ previewItem: preview })));
    const written = getLastPick();
    rerender(writerInputs({ previewItem: preview, getCurrentItemUuid: () => 'queue-other' }));
    // Still the pick the open wrote (a second write would have taken the new current).
    expect(getLastPick()).toBe(written);
  });

  it('writes nothing for the seeded first render', () => {
    renderHook((props: LastPickWriterInputs) => useLastPickWriter(props), {
      initialProps: writerInputs({ previewItem: item('a') }),
    });
    expect(getLastPick()).toBeNull();
  });

  it('records a swipe to another preview, its mirror flip, and its deferred commit', () => {
    const first = item('a');
    const second = item('b');
    const commitOptions = { placement: 'STEP' as const };
    const { result, rerender } = renderHook((props: LastPickWriterInputs) => useLastPickWriter(props), {
      initialProps: writerInputs(),
    });
    act(() => result.current.noteOpenApplied(applied({ previewItem: first, suggestionSource: track })));
    rerender(writerInputs({ previewItem: first, previewSuggestionSource: track }));
    rerender(
      writerInputs({ previewItem: second, previewSuggestionSource: track, getCommitOptions: () => commitOptions }),
    );
    expect(getLastPick()).toMatchObject({ item: second, suggestionSource: track, commitOptions, mirrored: false });
    rerender(
      writerInputs({
        previewItem: second,
        previewSuggestionSource: track,
        previewMirrored: true,
        getCommitOptions: () => commitOptions,
      }),
    );
    expect(getLastPick()).toMatchObject({ item: second, mirrored: true });
  });

  it('ends the pick when the player goes back to the committed climb', () => {
    const preview = item('a');
    const { result, rerender } = renderHook((props: LastPickWriterInputs) => useLastPickWriter(props), {
      initialProps: writerInputs(),
    });
    act(() => result.current.noteOpenApplied(applied({ previewItem: preview })));
    rerender(writerInputs({ previewItem: preview }));
    expect(getLastPick()).not.toBeNull();
    rerender(writerInputs({ previewItem: null }));
    expect(getLastPick()).toBeNull();
  });

  it('ends any pick on a committed open', () => {
    setLastPick({
      item: item('old'),
      suggestionSource: null,
      commitOptions: undefined,
      mirrored: false,
      currentAtPick: 'queue-current',
      wallAtPick: null,
      pickedAt: 0,
    });
    const { result } = renderHook((props: LastPickWriterInputs) => useLastPickWriter(props), {
      initialProps: writerInputs(),
    });
    act(() => result.current.noteOpenApplied(applied({ previewItem: null })));
    expect(getLastPick()).toBeNull();
  });

  it('writes nothing for the signed-out reader', () => {
    const { result, rerender } = renderHook((props: LastPickWriterInputs) => useLastPickWriter(props), {
      initialProps: writerInputs({ enabled: false }),
    });
    act(() => result.current.noteOpenApplied(applied({ previewItem: item('a') })));
    rerender(writerInputs({ enabled: false, previewItem: item('b') }));
    expect(getLastPick()).toBeNull();
  });
});

// A logbook, session or profile row opens on its own board and angle; the
// pick keeps that board, so the bar reopens it there and not at the active
// board's angle (`lastPickOpenOptions`).
describe('the board a pick was opened on', () => {
  const KILTER = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
  const ACTIVE = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };

  it.each([
    ['the active board', KILTER, ACTIVE, null],
    ['the active board at another angle', { ...KILTER, angle: 30 }, ACTIVE, { ...KILTER, angle: 30 }],
    [
      'another board',
      { ...KILTER, boardName: 'tension', layoutId: 9 },
      ACTIVE,
      { ...KILTER, boardName: 'tension', layoutId: 9 },
    ],
    ['no active board yet', KILTER, null, KILTER],
  ] as const)('is %s', (_label, shown, active, expected) => {
    expect(pickBoardOverride(shown, active)).toEqual(expected);
  });

  it('stores the override with the pick', () => {
    const atThirty = { ...KILTER, angle: 30 };
    const { result } = renderHook((props: LastPickWriterInputs) => useLastPickWriter(props), {
      initialProps: writerInputs({ getBoardOverride: () => atThirty }),
    });
    act(() => result.current.noteOpenApplied(applied({ previewItem: item('a') })));
    expect(getLastPick()?.boardConfig).toEqual(atThirty);
  });
});
