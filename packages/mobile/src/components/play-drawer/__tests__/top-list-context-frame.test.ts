import { describe, expect, it } from 'vitest';
import { resolveTopListContextFrame } from '../top-list-context-frame';

// iOS: 44pt chrome buttons, an 8pt edge inset. ⋯'s slot is its 8pt gap from
// the timer plus the 44pt button, so a signed-in cluster with no timer is 52.
const GAP = 8;
const BUTTON = 44;
const MENU_SLOT = GAP + BUTTON;
const TIMER = 80;

const frame = (overrides: Partial<Parameters<typeof resolveTopListContextFrame>[0]>) =>
  resolveTopListContextFrame({
    isPane: false,
    chromeButtonSize: BUTTON,
    trailingContentWidth: MENU_SLOT,
    hasMenu: true,
    gap: GAP,
    ...overrides,
  });

describe('resolveTopListContextFrame', () => {
  // A timer already running when the player opens would otherwise paint the
  // label under the pill for a frame.
  it('stays hidden until the timer and ⋯ have laid out', () => {
    expect(frame({ trailingContentWidth: null }).measured).toBe(false);
    expect(frame({ trailingContentWidth: MENU_SLOT }).measured).toBe(true);
  });

  it('centres on the screen, under the grabber, beside ⌄ and ⋯ alone', () => {
    expect(frame({})).toEqual({ left: 60, right: 60, measured: true });
  });

  it('centres in the room the timer leaves, so the name still fits beside it', () => {
    const withTimer = frame({ trailingContentWidth: TIMER + MENU_SLOT });
    expect(withTimer.left).toBe(60);
    // ⋯ edge inset + timer + ⋯, then the gap to the label.
    expect(withTimer.right).toBe(GAP + TIMER + BUTTON + GAP);
  });

  it('stays centred for a signed-out reader, who has no ⋯', () => {
    expect(frame({ trailingContentWidth: 0, hasMenu: false })).toEqual({ left: 60, right: 60, measured: true });
    expect(frame({ trailingContentWidth: TIMER, hasMenu: false }).right).toBe(GAP + TIMER + GAP);
  });

  it('has nothing to clear on the left in the iPad pane', () => {
    const pane = frame({ isPane: true });
    expect(pane.left).toBe(GAP);
    expect(pane.right).toBe(60);
  });
});
