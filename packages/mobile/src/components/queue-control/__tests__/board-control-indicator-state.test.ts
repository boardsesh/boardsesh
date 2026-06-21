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
