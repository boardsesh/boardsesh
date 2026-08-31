import { describe, it, expect } from 'vitest';
import { getBoardControlIndicatorVisual } from '../board-control-indicator-state';

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
