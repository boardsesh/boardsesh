// The busy-wall question's rule (#7017): who it names and how the pair fits the row.
import { describe, expect, it } from 'vitest';
import type { QueueItemUser } from '@boardsesh/queue';
import {
  BUSY_WALL_ROW_ORDER,
  BUSY_WALL_STACK_ORDER,
  resolveBusyWallFit,
  resolveBusyWallHolder,
  resolveBusyWallQuestion,
} from '../busy-wall-question';
import { formatBusyWallCaption, formatBusyWallQuestion } from '../busy-wall-question-text';
import type { TFunction } from 'i18next';

const WALL_CLIMB = 'climb-on-the-wall';
const SAM: QueueItemUser = { id: 'user-sam', username: 'Sam', avatarUrl: 'sam.png' };

// Renders the interpolations (person, then the climb) so the words can be asserted.
const t = ((key: string, params?: Record<string, string>) =>
  [key, params?.person, params?.name].filter((part) => part != null).join(':')) as unknown as TFunction<'session'>;

describe('resolveBusyWallHolder', () => {
  const holder = (overrides: Partial<Parameters<typeof resolveBusyWallHolder>[0]> = {}) =>
    resolveBusyWallHolder({
      picker: SAM,
      viewerUserId: 'me',
      wallClimbUuid: WALL_CLIMB,
      currentClimbUuid: WALL_CLIMB,
      ...overrides,
    });

  it('names whoever picked the crew’s current climb, face and all, when it is the lit one', () => {
    expect(holder()).toEqual({ name: 'Sam', avatarUrl: 'sam.png' });
  });

  // Each of these would name the wrong person, or the climber themself.
  it.each([
    ['the viewer put it up', { picker: { id: 'me', username: 'Me' } }],
    ['the crew’s current climb is not the lit one', { currentClimbUuid: 'climb-elsewhere' }],
    ['nobody is recorded as having put it up', { picker: null }],
    ['there is no current climb', { currentClimbUuid: null }],
    ['the viewer is not known yet (signed out, profile loading)', { viewerUserId: null }],
    ['the lit climb is unknown', { wallClimbUuid: null }],
  ] as const)('names nobody when %s', (_case, overrides) => {
    expect(holder(overrides)).toBeNull();
  });
});

describe('resolveBusyWallQuestion', () => {
  const question = (overrides: Partial<Parameters<typeof resolveBusyWallQuestion>[0]> = {}) =>
    resolveBusyWallQuestion({
      holder: { name: 'Test2', avatarUrl: null },
      wallClimbName: 'Crimp Ladder',
      selfHoldsBoard: true,
      ready: true,
      ...overrides,
    });

  it('fills Put mine up’s bulb only while this phone holds the board, as the wall button does', () => {
    expect(question().putBulbFilled).toBe(true);
    expect(question({ selfHoldsBoard: false }).putBulbFilled).toBe(false);
  });

  it('carries the debounce as its disabled state', () => {
    expect(question({ ready: false }).ready).toBe(false);
  });

  it('puts Keep left and Put mine up right, and Put mine up on top once stacked', () => {
    expect(BUSY_WALL_ROW_ORDER).toEqual(['keep', 'put']);
    expect(BUSY_WALL_STACK_ORDER).toEqual(['put', 'keep']);
  });

  it('words the caption and the labels with the holder’s name', () => {
    const model = question();
    expect(formatBusyWallCaption(model, t)).toBe('playView.wallState.busyWall.captionNamed:Test2:Crimp Ladder');
    expect(formatBusyWallQuestion(model, t)).toEqual({
      caption: 'playView.wallState.busyWall.captionNamed:Test2:Crimp Ladder',
      keepLabel: 'playView.wallState.commitOverride.cancelNamed:Test2',
      keepShortLabel: 'playView.wallState.commitOverride.cancel',
      putLabel: 'playView.wallState.commitOverride.confirm',
    });
  });

  it('says "Someone" and "Keep theirs" when nobody can be named', () => {
    const model = question({ holder: null });
    expect(model.holderFace).toBeNull();
    expect(formatBusyWallCaption(model, t)).toBe('playView.wallState.busyWall.caption:Crimp Ladder');
    expect(formatBusyWallQuestion(model, t).keepLabel).toBe('playView.wallState.commitOverride.cancel');
  });

  it('cuts a long climb name first, so the line keeps who put it up', () => {
    const model = question({ wallClimbName: 'The Extremely Long Name Of A Project Climb' });
    expect(formatBusyWallCaption(model, t)).toBe(
      'playView.wallState.busyWall.captionNamed:Test2:The Extremely Long Name…',
    );
  });
});

describe('resolveBusyWallFit', () => {
  // A 393pt phone: 361pt inside the 16pt gutters, so each half has 176.5pt and
  // 120.5pt of it for the label.
  const fit = (overrides: Partial<Parameters<typeof resolveBusyWallFit>[0]> = {}) =>
    resolveBusyWallFit({ rowWidth: 361, putLabelWidth: 85, keepLabelWidth: 90, keepShortLabelWidth: 80, ...overrides });

  it('sits side by side with the name before anything measures', () => {
    expect(fit({ rowWidth: null })).toEqual({ stacked: false, keepLabel: 'full' });
    expect(fit({ keepLabelWidth: null })).toEqual({ stacked: false, keepLabel: 'full' });
  });

  it('sits side by side with the name where both labels fit', () => {
    expect(fit()).toEqual({ stacked: false, keepLabel: 'full' });
    expect(fit({ keepLabelWidth: 120.5 })).toEqual({ stacked: false, keepLabel: 'full' });
  });

  it('says "Keep theirs" where the name won’t fit in half the row', () => {
    expect(fit({ keepLabelWidth: 150 })).toEqual({ stacked: false, keepLabel: 'short' });
  });

  it('stacks full width where even "Keep theirs" or Put mine up won’t fit (German, large type)', () => {
    expect(fit({ keepLabelWidth: 200, keepShortLabelWidth: 130 })).toEqual({ stacked: true, keepLabel: 'full' });
    expect(fit({ putLabelWidth: 140 })).toEqual({ stacked: true, keepLabel: 'full' });
  });

  it('keeps "Keep theirs" stacked where the name won’t fit even the whole row', () => {
    expect(fit({ putLabelWidth: 140, keepLabelWidth: 400 })).toEqual({ stacked: true, keepLabel: 'short' });
  });
});
