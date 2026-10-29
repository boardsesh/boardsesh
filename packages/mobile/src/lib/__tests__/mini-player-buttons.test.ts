import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MINI_PLAYER_BUTTONS,
  MINI_PLAYER_BUTTONS_LAYOUT,
  listedMiniPlayerButtons,
  miniPlayerMoveSteps,
} from '../mini-player-buttons';
import { sanitiseSectionLayout, withSectionMoved } from '../section-layout';

describe('Wall display in the MiniPlayer buttons', () => {
  it('is on by default, straight after Favorite', () => {
    expect(DEFAULT_MINI_PLAYER_BUTTONS.visible.wallDisplay).toBe(true);
    const { order } = DEFAULT_MINI_PLAYER_BUTTONS;
    expect(order.indexOf('wallDisplay')).toBe(order.indexOf('favorite') + 1);
  });

  it('joins a layout saved before it existed through the defaults merge', () => {
    const saved = {
      order: ['angle', 'next', 'previous', 'mirror', 'favorite', 'queue', 'share'],
      visible: { angle: true, favorite: false },
    };
    const layout = sanitiseSectionLayout(MINI_PLAYER_BUTTONS_LAYOUT, saved);
    expect(layout.order).toEqual(['angle', 'next', 'previous', 'mirror', 'favorite', 'wallDisplay', 'queue', 'share']);
    expect(layout.visible.wallDisplay).toBe(true);
    expect(layout.visible.favorite).toBe(false);
  });

  it('is listed on a tablet only', () => {
    expect(listedMiniPlayerButtons(DEFAULT_MINI_PLAYER_BUTTONS.order, true)).toContain('wallDisplay');
    expect(listedMiniPlayerButtons(DEFAULT_MINI_PLAYER_BUTTONS.order, false)).not.toContain('wallDisplay');
  });

  it("steps a phone's move over Wall display, so every move it offers moves a row", () => {
    const buttons = DEFAULT_MINI_PLAYER_BUTTONS;
    expect(miniPlayerMoveSteps(buttons, 'favorite', 1, false)).toBe(2);
    expect(miniPlayerMoveSteps(buttons, 'queue', -1, false)).toBe(2);
    expect(miniPlayerMoveSteps(buttons, 'favorite', 1, true)).toBe(1);
    expect(miniPlayerMoveSteps(buttons, 'mirror', 1, false)).toBe(1);
    expect(miniPlayerMoveSteps(buttons, 'next', -1, false)).toBe(0);
    expect(miniPlayerMoveSteps(buttons, 'angle', 1, false)).toBe(0);
    // Two swaps put Favorite below Queue on a phone's list.
    const once = withSectionMoved(MINI_PLAYER_BUTTONS_LAYOUT, buttons, 'favorite', 1);
    const twice = withSectionMoved(MINI_PLAYER_BUTTONS_LAYOUT, once, 'favorite', 1);
    expect(listedMiniPlayerButtons(twice.order, false)).toEqual([
      'next',
      'previous',
      'mirror',
      'queue',
      'favorite',
      'share',
      'angle',
    ]);
  });
});
