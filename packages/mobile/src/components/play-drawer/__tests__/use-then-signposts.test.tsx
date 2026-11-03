// @vitest-environment jsdom
// The then-signposts in the player (owner-approved 2026-11-02): the preview
// note and its caps, the crossing tick and its landing announcement, the top
// bar's "Up next first" line, the board's spoken extras, and the walk each step
// reports. Every rule is read against the English catalog, so the words are
// the ones a climber sees.
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { PlaylistSuggestionSource } from '@boardsesh/queue';
import type { TrackLabelModel } from '@boardsesh/play-view';
import enSession from '@boardsesh/i18n/locales/en-US/session.json';

const effects = vi.hoisted(() => ({ hapticSelection: vi.fn(), announceQueued: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: effects.hapticSelection }));
vi.mock('../../../lib/announce-queued', () => ({ announceQueued: effects.announceQueued }));

import { resetPreviewNotesForTests, useThenSignposts } from '../use-then-signposts';
import { PREVIEW_NOTE_RUN_CAP, resolvePreviewNoteOnLine } from '../then-signposts';
import type { PlayNavigationSignposts } from '../use-play-navigation-model';
import type { PlayNavigationStep } from '../use-play-selection-controller';
import type { TrackLabelParts } from '../track-label-text';

/** The English catalog, interpolated and pluralised the way i18next does it. */
const t = ((key: string, values: Record<string, string | number> = {}) => {
  const lookup = (path: string): unknown =>
    path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], enSession);
  const count = values.count;
  const template =
    typeof count === 'number' ? (lookup(`${key}_${count === 1 ? 'one' : 'other'}`) ?? lookup(key)) : lookup(key);
  if (typeof template !== 'string') return key;
  return template.replace(/\{\{(\w+)\}\}/g, (_, field: string) => `${values[field] ?? ''}`);
}) as unknown as TFunction<'session'>;

const projects: PlaylistSuggestionSource = {
  playlistUuid: 'smart:projects',
  activatedClimbUuid: 'l1',
  boardKey: 'kilter:1',
  climbs: [],
  label: 'Projects',
};
const search: PlaylistSuggestionSource = { ...projects, playlistUuid: 'search', label: 'Search results' };

const onList: TrackLabelModel = { kind: 'counted', name: 'Search results', position: 5, total: 23 };
const lastUpNext: TrackLabelModel = {
  kind: 'upNext',
  listName: 'Projects',
  count: { position: 4, total: 4 },
  thenListName: 'Projects',
};
const lastUpNextParts: TrackLabelParts = {
  name: 'Up next',
  count: '4 of 4',
  thenTail: { before: 'then ', name: 'Projects', after: '' },
  accessibilityLabel: 'Up next, 4 of 4, then Projects',
};

const quiet: PlayNavigationSignposts = {
  upNextCount: 4,
  nextTrack: 'list',
  previousTrack: 'list',
  nextCrosses: false,
  previousCrosses: false,
  upNextFirstCount: null,
};

type Props = Parameters<typeof useThenSignposts>[0];

/** A list preview from Search results, 4 waiting in Up next, at 5 of 23. */
function listPreview(overrides: Partial<Props> = {}): Props {
  return {
    enabled: true,
    isPreview: true,
    previewSource: search,
    trackLabel: onList,
    trackParts: null,
    signposts: quiet,
    displayedClimbUuid: 's5',
    nextClimbUuid: 's6',
    previousClimbUuid: 's4',
    t,
    locale: 'en-US',
    ...overrides,
  };
}

const swipeNext: PlayNavigationStep = { direction: 'next', method: 'swipe', outcome: 'preview' };

/**
 * One step from `props` towards `landedOn`, then the render after it lands
 * there. A note that lands is put on line 2, as the player does when nothing
 * outranks it; `lineTwoTaken` holds it back, as the busy wall would.
 */
function stepAndLand(
  hook: { result: { current: ReturnType<typeof useThenSignposts> }; rerender: (props: Props) => void },
  props: Props,
  step: PlayNavigationStep,
  landedOn: string,
  { lineTwoTaken = false }: { lineTwoTaken?: boolean } = {},
) {
  const target = step.direction === 'next' ? { nextClimbUuid: landedOn } : { previousClimbUuid: landedOn };
  hook.rerender({ ...props, ...target });
  act(() => {
    hook.result.current.onStep(step);
  });
  hook.rerender({ ...props, displayedClimbUuid: landedOn, nextClimbUuid: `${landedOn}+1`, previousClimbUuid: null });
  if (!lineTwoTaken && hook.result.current.previewNote !== null) {
    act(() => hook.result.current.markPreviewNoteShown());
  }
}

beforeEach(() => {
  resetPreviewNotesForTests();
  effects.hapticSelection.mockClear();
  effects.announceQueued.mockClear();
});

describe('the preview note', () => {
  it('swaps the second line for "Up next: 4 waiting" after the first swipe, until the next step', () => {
    const props = listPreview();
    const hook = renderHook(useThenSignposts, { initialProps: props });
    expect(hook.result.current.previewNote).toBeNull();
    stepAndLand(hook, props, swipeNext, 's6');
    expect(hook.result.current.previewNote).toBe('Preview · Up next: 4 waiting');
    // No timer: it stays while the climber looks.
    hook.rerender({ ...props, displayedClimbUuid: 's6' });
    expect(hook.result.current.previewNote).toBe('Preview · Up next: 4 waiting');
    // The next swipe takes it away, and this open never shows it again.
    stepAndLand(hook, { ...props, displayedClimbUuid: 's6' }, swipeNext, 's7');
    expect(hook.result.current.previewNote).toBeNull();
    // Not even back on the climb it was shown on.
    stepAndLand(hook, { ...props, displayedClimbUuid: 's7' }, { ...swipeNext, direction: 'previous' }, 's6');
    expect(hook.result.current.previewNote).toBeNull();
  });

  it('shows once per player open', () => {
    const props = listPreview();
    const hook = renderHook(useThenSignposts, { initialProps: props });
    stepAndLand(hook, props, swipeNext, 's6');
    stepAndLand(hook, props, { ...swipeNext, direction: 'previous' }, 's5');
    expect(hook.result.current.previewNote).toBeNull();
    act(() => hook.result.current.resetForOpen());
    stepAndLand(hook, props, swipeNext, 's6');
    expect(hook.result.current.previewNote).toBe('Preview · Up next: 4 waiting');
  });

  it(`shows at most ${PREVIEW_NOTE_RUN_CAP} times per app run`, () => {
    const props = listPreview();
    const hook = renderHook(useThenSignposts, { initialProps: props });
    for (let open = 0; open < PREVIEW_NOTE_RUN_CAP; open += 1) {
      act(() => hook.result.current.resetForOpen());
      stepAndLand(hook, props, swipeNext, `s${open + 10}`);
      expect(hook.result.current.previewNote).toBe('Preview · Up next: 4 waiting');
    }
    act(() => hook.result.current.resetForOpen());
    stepAndLand(hook, props, swipeNext, 's99');
    expect(hook.result.current.previewNote).toBeNull();
    // A fresh hook is the same run: the cap holds across player mounts.
    const remounted = renderHook(useThenSignposts, { initialProps: props });
    stepAndLand(remounted, props, swipeNext, 's6');
    expect(remounted.result.current.previewNote).toBeNull();
  });

  it.each([
    ['Up next is empty', listPreview({ signposts: { ...quiet, upNextCount: 0 } }), swipeNext],
    ['the step was a button press', listPreview(), { ...swipeNext, method: 'button' } as PlayNavigationStep],
    ['the step put a climb up (driving)', listPreview(), { ...swipeNext, outcome: 'moved' } as PlayNavigationStep],
    [
      'the preview is a look off your own climb',
      listPreview({ previewSource: { ...projects, lookOffWall: true } }),
      swipeNext,
    ],
    ['the list has no name', listPreview({ trackLabel: { kind: 'hidden' } }), swipeNext],
    ['a workout keeps the top bar', listPreview({ enabled: false }), swipeNext],
    ['it is your own climb', listPreview({ isPreview: false, previewSource: null }), swipeNext],
  ] as const)('never shows when %s', (_case, props, step) => {
    const hook = renderHook(useThenSignposts, { initialProps: props });
    stepAndLand(hook, props, step, 's6');
    expect(hook.result.current.previewNote).toBeNull();
  });

  it('spends nothing on a note the busy wall or a crewmate kept off line 2', () => {
    const props = listPreview();
    const hook = renderHook(useThenSignposts, { initialProps: props });
    // Earned on every open, but never shown: neither cap is spent.
    for (let open = 0; open < PREVIEW_NOTE_RUN_CAP + 1; open += 1) {
      act(() => hook.result.current.resetForOpen());
      stepAndLand(hook, props, swipeNext, `s${open + 10}`, { lineTwoTaken: true });
      expect(hook.result.current.previewNote).toBe('Preview · Up next: 4 waiting');
    }
    // Within one open, the next swipe may still earn it, and this time it shows.
    stepAndLand(hook, { ...props, displayedClimbUuid: 's13' }, swipeNext, 's14', { lineTwoTaken: true });
    expect(hook.result.current.previewNote).toBe('Preview · Up next: 4 waiting');
    stepAndLand(hook, { ...props, displayedClimbUuid: 's14' }, swipeNext, 's15');
    expect(hook.result.current.previewNote).toBe('Preview · Up next: 4 waiting');
    // Shown now: this open is spent.
    stepAndLand(hook, { ...props, displayedClimbUuid: 's15' }, swipeNext, 's16');
    expect(hook.result.current.previewNote).toBeNull();
  });

  it('counts a shown note once, however often line 2 says so', () => {
    const props = listPreview();
    const hook = renderHook(useThenSignposts, { initialProps: props });
    stepAndLand(hook, props, swipeNext, 's6');
    act(() => hook.result.current.markPreviewNoteShown());
    act(() => hook.result.current.markPreviewNoteShown());
    // Two more opens still show it: the run spent one, not three.
    for (const landedOn of ['s7', 's8']) {
      act(() => hook.result.current.resetForOpen());
      stepAndLand(hook, props, swipeNext, landedOn);
      expect(hook.result.current.previewNote).toBe('Preview · Up next: 4 waiting');
    }
    act(() => hook.result.current.resetForOpen());
    stepAndLand(hook, props, swipeNext, 's9');
    expect(hook.result.current.previewNote).toBeNull();
  });

  it('goes when Put on board makes the climb it was shown on your own', () => {
    const props = listPreview();
    const hook = renderHook(useThenSignposts, { initialProps: props });
    stepAndLand(hook, props, swipeNext, 's6');
    expect(hook.result.current.previewNote).toBe('Preview · Up next: 4 waiting');
    // Same climb on screen, no longer a preview: "Preview · …" would be false.
    hook.rerender({ ...props, displayedClimbUuid: 's6', isPreview: false, previewSource: null });
    expect(hook.result.current.previewNote).toBeNull();
  });

  it('is pluralised by the count', () => {
    const props = listPreview({ signposts: { ...quiet, upNextCount: 1 } });
    const hook = renderHook(useThenSignposts, { initialProps: props });
    stepAndLand(hook, props, swipeNext, 's6');
    expect(hook.result.current.previewNote).toBe('Preview · Up next: 1 waiting');
  });

  it('does not spend the run on a step that showed nothing', () => {
    const props = listPreview({ signposts: { ...quiet, upNextCount: 0 } });
    const hook = renderHook(useThenSignposts, { initialProps: props });
    for (let step = 0; step < PREVIEW_NOTE_RUN_CAP + 1; step += 1) stepAndLand(hook, props, swipeNext, `s${step}`);
    const queued = listPreview();
    const later = renderHook(useThenSignposts, { initialProps: queued });
    stepAndLand(later, queued, swipeNext, 's6');
    expect(later.result.current.previewNote).toBe('Preview · Up next: 4 waiting');
  });
});

describe('line 2 for the note', () => {
  const note = 'Preview · Up next: 4 waiting';

  it('shows the note when nothing outranks it', () => {
    expect(resolvePreviewNoteOnLine({ previewNote: note, busyWallUp: false, crewPutUpCaption: null })).toBe(note);
    expect(resolvePreviewNoteOnLine({ previewNote: null, busyWallUp: false, crewPutUpCaption: null })).toBeNull();
  });

  it.each([
    ['the busy-wall question', { busyWallUp: true, crewPutUpCaption: null }],
    ["a crewmate's put-up", { busyWallUp: false, crewPutUpCaption: 'Your crew put up Crimp Ladder' }],
    [
      'the board letting go mid-drive',
      { busyWallUp: false, letsGoCaption: 'Sam took the board', crewPutUpCaption: null },
    ],
  ])('gives line 2 to %s', (_case, outranking) => {
    expect(resolvePreviewNoteOnLine({ previewNote: note, ...outranking })).toBeNull();
  });
});

describe('the crossing cue', () => {
  // Your climb is the last of Up next; the next swipe lands on "Projects · 8 of 20".
  const crossing = (overrides: Partial<Props> = {}) =>
    listPreview({
      isPreview: false,
      previewSource: null,
      trackLabel: lastUpNext,
      trackParts: lastUpNextParts,
      signposts: { ...quiet, nextCrosses: true },
      displayedClimbUuid: 'bird-blind',
      nextClimbUuid: 'l8',
      ...overrides,
    });
  const landed: TrackLabelModel = { kind: 'counted', name: 'Projects', position: 8, total: 20 };

  it('ticks once on your swipe across, and says where it landed', () => {
    const props = crossing();
    const hook = renderHook(useThenSignposts, { initialProps: props });
    act(() => {
      hook.result.current.onStep({ direction: 'next', method: 'swipe', outcome: 'moved' });
    });
    expect(effects.hapticSelection).toHaveBeenCalledTimes(1);
    // Still on the climb it left: nothing to say yet.
    hook.rerender({ ...props, trackLabel: landed });
    expect(effects.announceQueued).not.toHaveBeenCalled();
    hook.rerender({ ...props, displayedClimbUuid: 'l8', trackLabel: landed });
    expect(effects.announceQueued).toHaveBeenCalledExactlyOnceWith('Now in Projects, 8 of 20');
    hook.rerender({ ...props, displayedClimbUuid: 'l8', trackLabel: { ...landed } });
    expect(effects.announceQueued).toHaveBeenCalledTimes(1);
  });

  it('stays silent for a Next button across, but a screen reader still hears the landing', () => {
    const props = crossing();
    const hook = renderHook(useThenSignposts, { initialProps: props });
    act(() => {
      hook.result.current.onStep({ direction: 'next', method: 'button', outcome: 'moved' });
    });
    hook.rerender({ ...props, displayedClimbUuid: 'l8', trackLabel: landed });
    expect(effects.hapticSelection).not.toHaveBeenCalled();
    expect(effects.announceQueued).toHaveBeenCalledExactlyOnceWith('Now in Projects, 8 of 20');
  });

  it('ticks crossing back from the first Up next climb too', () => {
    const props = crossing({ signposts: { ...quiet, previousCrosses: true }, previousClimbUuid: 'l7' });
    const hook = renderHook(useThenSignposts, { initialProps: props });
    act(() => {
      hook.result.current.onStep({ direction: 'previous', method: 'swipe', outcome: 'moved' });
    });
    expect(effects.hapticSelection).toHaveBeenCalledTimes(1);
    hook.rerender({ ...props, displayedClimbUuid: 'l7', trackLabel: { ...landed, position: 7 } });
    expect(effects.announceQueued).toHaveBeenCalledExactlyOnceWith('Now in Projects, 7 of 20');
  });

  it.each([
    ['a step that stays in Up next', crossing({ signposts: quiet })],
    ['a workout', crossing({ enabled: false })],
  ])('gives nothing on %s', (_case, props) => {
    const hook = renderHook(useThenSignposts, { initialProps: props });
    act(() => {
      hook.result.current.onStep({ direction: 'next', method: 'swipe', outcome: 'moved' });
    });
    hook.rerender({ ...props, displayedClimbUuid: 'l8', trackLabel: landed });
    expect(effects.hapticSelection).not.toHaveBeenCalled();
    expect(effects.announceQueued).not.toHaveBeenCalled();
  });

  it('says nothing when the step landed somewhere else', () => {
    const props = crossing();
    const hook = renderHook(useThenSignposts, { initialProps: props });
    act(() => {
      hook.result.current.onStep({ direction: 'next', method: 'swipe', outcome: 'moved' });
    });
    hook.rerender({ ...props, displayedClimbUuid: 'crewmate-pick', trackLabel: landed });
    hook.rerender({ ...props, displayedClimbUuid: 'l8', trackLabel: landed });
    expect(effects.announceQueued).not.toHaveBeenCalled();
  });

  it('a non-crossing step cancels a landing still to come', () => {
    const props = crossing();
    const hook = renderHook(useThenSignposts, { initialProps: props });
    act(() => {
      hook.result.current.onStep({ direction: 'next', method: 'swipe', outcome: 'moved' });
    });
    act(() => {
      hook.result.current.onStep({ direction: 'previous', method: 'swipe', outcome: 'moved' });
    });
    hook.rerender({ ...props, displayedClimbUuid: 'l8', trackLabel: landed });
    expect(effects.announceQueued).not.toHaveBeenCalled();
  });
});

describe('the second line on your own climb', () => {
  const own = (overrides: Partial<Props> = {}) =>
    listPreview({
      isPreview: false,
      previewSource: null,
      trackLabel: { kind: 'counted', name: 'Projects', position: 7, total: 20 },
      signposts: { ...quiet, nextTrack: 'upNext', upNextFirstCount: 4 },
      ...overrides,
    });

  it('says "Up next first · 4 climbs" when Next plays Up next', () => {
    expect(renderHook(() => useThenSignposts(own())).result.current.upNextFirstCaption).toBe(
      'Up next first · 4 climbs',
    );
    const one = own({ signposts: { ...quiet, nextTrack: 'upNext', upNextFirstCount: 1 } });
    expect(renderHook(() => useThenSignposts(one)).result.current.upNextFirstCaption).toBe('Up next first · 1 climb');
  });

  it.each([
    ['Next stays on the list', own({ signposts: quiet })],
    ['it is a preview', own({ isPreview: true })],
    ['a workout keeps the top bar', own({ enabled: false })],
    ['no list is named', own({ trackLabel: { kind: 'hidden' } })],
    ['the climb plays Up next itself', own({ trackLabel: lastUpNext })],
  ])('says nothing when %s', (_case, props) => {
    expect(renderHook(() => useThenSignposts(props)).result.current.upNextFirstCaption).toBeNull();
  });
});

describe("the board's spoken extras", () => {
  it('reads the Up next stretch and what comes after, and names the action that crosses', () => {
    const props = listPreview({
      isPreview: false,
      trackLabel: lastUpNext,
      trackParts: lastUpNextParts,
      signposts: { ...quiet, nextCrosses: true },
    });
    expect(renderHook(() => useThenSignposts(props)).result.current.board).toEqual({
      valueText: 'Up next, 4 of 4, then Projects',
      nextActionLabel: 'Next in Projects',
      previousActionLabel: undefined,
    });
  });

  it('adds nothing on a list climb, or in a workout', () => {
    const onListParts: TrackLabelParts = {
      name: 'Search results',
      count: '5 of 23',
      accessibilityLabel: 'Playing from Search results, 5 of 23',
    };
    // The top bar already reads a list climb's place: the board says nothing new.
    const listClimb = listPreview({ trackParts: onListParts, signposts: { ...quiet, nextCrosses: true } });
    expect(renderHook(() => useThenSignposts(listClimb)).result.current.board).toStrictEqual({});
    const workout = listPreview({ enabled: false, trackLabel: lastUpNext, trackParts: lastUpNextParts });
    expect(renderHook(() => useThenSignposts(workout)).result.current.board).toStrictEqual({});
  });
});

describe('the walk each step reports', () => {
  it('says the track, where it was taken from, Up next and the crossing', () => {
    const props = listPreview({
      signposts: { ...quiet, nextTrack: 'upNext', previousTrack: 'list', previousCrosses: true },
    });
    const { result } = renderHook(() => useThenSignposts(props));
    let walk: ReturnType<typeof result.current.onStep> | undefined;
    act(() => {
      walk = result.current.onStep({ direction: 'next', method: 'button', outcome: 'preview' });
    });
    expect(walk).toEqual({ track: 'upNext', from: 'preview', upNextCount: 4, crossed: false });
    act(() => {
      walk = result.current.onStep({ direction: 'previous', method: 'button', outcome: 'preview' });
    });
    expect(walk).toEqual({ track: 'list', from: 'preview', upNextCount: 4, crossed: true });
  });

  it('reports from your own climb, in a workout too', () => {
    const { result } = renderHook(() => useThenSignposts(listPreview({ enabled: false, isPreview: false })));
    let walk: ReturnType<typeof result.current.onStep> | undefined;
    act(() => {
      walk = result.current.onStep({ direction: 'next', method: 'swipe', outcome: 'moved' });
    });
    expect(walk?.from).toBe('current');
  });
});
