import { describe, it, expect } from 'vitest';
import {
  getBoardConnectionBadgeVisual,
  getBoardConnectionLabel,
  getBoardControlIndicatorVisual,
} from '../board-control-indicator-state';

const colors = {
  connectedColor: '#FBBF24',
  peerColor: '#8E8898',
  disconnectedColor: '#8E8898',
};

describe('getBoardControlIndicatorVisual', () => {
  it('glows: a warm filled bulb with a halo only when this device has control', () => {
    const visual = getBoardControlIndicatorVisual({ boardConnection: 'connectedByMe', ...colors });
    expect(visual.iconName).toBe('lightbulb.fill');
    expect(visual.iconColor).toBe('#FBBF24');
    // ~14% alpha halo, mirroring the in-drawer lightbulb's `${connectedColor}24`.
    expect(visual.haloColor).toBe('#FBBF2424');
  });

  it('does not glow: a neutral person glyph (no halo) when a teammate drives the wall', () => {
    const visual = getBoardControlIndicatorVisual({ boardConnection: 'heldByPeer', ...colors });
    expect(visual.iconName).toBe('person.fill');
    expect(visual.iconColor).toBe('#8E8898');
    expect(visual.haloColor).toBeUndefined();
  });

  it('does not glow: a neutral outline bulb (no halo) when disconnected', () => {
    const visual = getBoardControlIndicatorVisual({ boardConnection: 'disconnected', ...colors });
    expect(visual.iconName).toBe('lightbulb');
    expect(visual.iconColor).toBe('#8E8898');
    expect(visual.haloColor).toBeUndefined();
  });
});

describe('getBoardControlIndicatorVisual on a wall with no LED light kit', () => {
  const ledlessColors = { ...colors, ledless: true, wallHeldColor: '#6D28D9' };

  it('pins instead of lighting a bulb: a bulb on a wall with no bulbs is a false statement', () => {
    const visual = getBoardControlIndicatorVisual({ boardConnection: 'connectedByMe', ...ledlessColors });
    expect(visual.iconName).toBe('pin.fill');
    // The brand tone, never the warm amber — amber means the LEDs are on and
    // must stay exclusive to a real write.
    expect(visual.iconColor).toBe('#6D28D9');
    expect(visual.iconColor).not.toBe(colors.connectedColor);
    expect(visual.haloColor).toBe('#6D28D924');
  });

  it('shows the open wall as an outline pin, no halo', () => {
    const visual = getBoardControlIndicatorVisual({ boardConnection: 'disconnected', ...ledlessColors });
    expect(visual.iconName).toBe('pin');
    expect(visual.haloColor).toBeUndefined();
  });

  it('shows a peer holding the wall with the same person glyph as an LED board', () => {
    const visual = getBoardControlIndicatorVisual({ boardConnection: 'heldByPeer', ...ledlessColors });
    expect(visual.iconName).toBe('person.fill');
    expect(visual.haloColor).toBeUndefined();
  });

  it('carries every ledless state by shape, so it reads without hue', () => {
    const shapes = (['connectedByMe', 'heldByPeer', 'disconnected'] as const).map(
      (boardConnection) => getBoardControlIndicatorVisual({ boardConnection, ...ledlessColors }).iconName,
    );
    expect(new Set(shapes).size).toBe(3);
  });

  it('is byte-identical to today when the board has lights', () => {
    for (const boardConnection of ['connectedByMe', 'heldByPeer', 'disconnected'] as const) {
      expect(getBoardControlIndicatorVisual({ boardConnection, ...colors, ledless: false })).toEqual(
        getBoardControlIndicatorVisual({ boardConnection, ...colors }),
      );
    }
  });
});

// The iOS 26 accessory platter draws its glyphs solid, like Apple Music's. Off then
// reads by colour and the held state's halo; the indicator turns this off under
// Differentiate Without Color, which brings the outline back.
describe('getBoardControlIndicatorVisual with solid glyphs', () => {
  const ledlessColors = { ...colors, ledless: true, wallHeldColor: '#6D28D9' };

  it('fills the open bulb and the open pin, in the neutral tone, with no halo', () => {
    const bulb = getBoardControlIndicatorVisual({ boardConnection: 'disconnected', ...colors, solidGlyphs: true });
    expect(bulb.iconName).toBe('lightbulb.fill');
    expect(bulb.iconColor).toBe(colors.disconnectedColor);
    expect(bulb.haloColor).toBeUndefined();

    const pin = getBoardControlIndicatorVisual({
      boardConnection: 'disconnected',
      ...ledlessColors,
      solidGlyphs: true,
    });
    expect(pin.iconName).toBe('pin.fill');
    expect(pin.haloColor).toBeUndefined();
  });

  it('leaves the held and peer states as they are', () => {
    for (const boardConnection of ['connectedByMe', 'heldByPeer'] as const) {
      expect(getBoardControlIndicatorVisual({ boardConnection, ...colors, solidGlyphs: true })).toEqual(
        getBoardControlIndicatorVisual({ boardConnection, ...colors }),
      );
    }
  });
});

describe('getBoardConnectionBadgeVisual', () => {
  const badgeColors = { connectedColor: '#FBBF24', peerColor: '#8E8898', wallHeldColor: '#6D28D9' };

  it('marks lit LEDs you hold with the amber bulb', () => {
    expect(getBoardConnectionBadgeVisual({ boardConnection: 'connectedByMe', ...badgeColors })).toEqual({
      iconName: 'lightbulb.fill',
      iconColor: '#FBBF24',
    });
  });

  it('marks a board with no lights you hold with a pin in the brand tone', () => {
    expect(getBoardConnectionBadgeVisual({ boardConnection: 'connectedByMe', ledless: true, ...badgeColors })).toEqual({
      iconName: 'pin.fill',
      iconColor: '#6D28D9',
    });
  });

  it.each([false, true])('marks a teammate holding the wall with a neutral person (ledless: %s)', (ledless) => {
    expect(getBoardConnectionBadgeVisual({ boardConnection: 'heldByPeer', ledless, ...badgeColors })).toEqual({
      iconName: 'person.fill',
      iconColor: '#8E8898',
    });
  });

  it.each([false, true])('shows no mark while the board is free (ledless: %s)', (ledless) => {
    expect(getBoardConnectionBadgeVisual({ boardConnection: 'disconnected', ledless, ...badgeColors })).toBeNull();
  });

  it('keeps amber for lit LEDs only', () => {
    const tones = (['connectedByMe', 'heldByPeer', 'disconnected'] as const).flatMap((boardConnection) =>
      [false, true].map(
        (ledless) =>
          [
            boardConnection,
            ledless,
            getBoardConnectionBadgeVisual({ boardConnection, ledless, ...badgeColors })?.iconColor,
          ] as const,
      ),
    );
    const amber = tones.filter(([, , color]) => color === '#FBBF24');
    expect(amber).toEqual([['connectedByMe', false, '#FBBF24']]);
  });
});

describe('getBoardConnectionLabel', () => {
  const t = ((key: string, options?: { name?: string }) =>
    options?.name ? `${key}:${options.name}` : key) as unknown as Parameters<typeof getBoardConnectionLabel>[0];

  it.each([
    ['connectedByMe', false, null, 'ble.barControl.connectedLabel'],
    ['connectedByMe', true, null, 'ble.barControl.wallHeldLabel'],
    ['heldByPeer', false, 'Alex', 'ble.barControl.peerLabel:Alex'],
    ['heldByPeer', false, null, 'ble.barControl.peerLabelAnonymous'],
    ['disconnected', false, null, 'ble.barControl.disconnectedLabel'],
    ['disconnected', true, null, 'ble.barControl.wallOpenLabel'],
  ] as const)('%s (ledless %s, holder %s) reads %s', (boardConnection, ledless, holderDisplayName, expected) => {
    expect(getBoardConnectionLabel(t, { boardConnection, ledless, holderDisplayName })).toBe(expected);
  });
});
