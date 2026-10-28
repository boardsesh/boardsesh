import { describe, expect, it } from 'vitest';
import { queueNavigation, queueSheetOpened } from '../queue-navigation-events';

describe('queueNavigation', () => {
  it('names the event www fired and carries the step, the session and the board', () => {
    expect(
      queueNavigation({
        direction: 'previous',
        method: 'swipe',
        surface: 'player',
        outcome: 'preview',
        inSharedSession: true,
        lightOnSwipe: true,
        boardType: 'kilter',
        layoutId: 1,
      }),
    ).toEqual({
      name: 'Queue Navigation',
      properties: {
        direction: 'previous',
        method: 'swipe',
        surface: 'player',
        outcome: 'preview',
        sessionMode: 'party',
        lightOnSwipe: true,
        boardType: 'kilter',
        layoutId: 1,
      },
    });
  });

  it('reads solo outside a crew', () => {
    const { properties } = queueNavigation({
      direction: 'next',
      method: 'button',
      surface: 'mini_player',
      outcome: 'moved',
      inSharedSession: false,
      lightOnSwipe: false,
      boardType: 'tension',
      layoutId: 9,
    });
    expect(properties.sessionMode).toBe('solo');
    expect(properties.lightOnSwipe).toBe(false);
  });

  it('sends no layout id on a spray wall, whose layout id names the wall', () => {
    const { properties } = queueNavigation({
      direction: 'next',
      method: 'button',
      surface: 'player',
      outcome: 'moved',
      inSharedSession: false,
      lightOnSwipe: true,
      boardType: 'spray',
      layoutId: 123456,
    });
    expect(properties.boardType).toBe('spray');
    expect(properties.layoutId).toBeNull();
  });

  it('sends null for a board it does not know, never the raw value', () => {
    const { properties } = queueNavigation({
      direction: 'next',
      method: 'button',
      surface: 'player',
      outcome: 'moved',
      inSharedSession: false,
      lightOnSwipe: true,
      boardType: 'my-home-wall',
      layoutId: undefined,
    });
    expect(properties.boardType).toBeNull();
    expect(properties.layoutId).toBeNull();
  });
});

describe('queueSheetOpened', () => {
  it('carries the surface and the board type only', () => {
    expect(queueSheetOpened({ surface: 'mini_player', boardType: 'moonboard' })).toEqual({
      name: 'Queue Sheet Opened',
      properties: { surface: 'mini_player', boardType: 'moonboard' },
    });
  });
});
