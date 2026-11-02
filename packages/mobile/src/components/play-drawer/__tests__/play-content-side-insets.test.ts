import { describe, expect, it } from 'vitest';
import { NO_HORIZONTAL_SAFE_AREA } from '../../../hooks/horizontal-safe-area';
import { playContentSideInsets } from '../play-content-side-insets';

// INFERRED: iPhone Duo's side status bar column, as the window reports it.
const DUO_SIDE_INSETS = { left: 0, right: 84 };

describe('playContentSideInsets', () => {
  it("pads the full-screen player clear of iPhone Duo's side status bar", () => {
    expect(playContentSideInsets('route', DUO_SIDE_INSETS)).toEqual({ left: 0, right: 84 });
  });

  it('leaves the pane to its host, so the inset is never applied twice', () => {
    expect(playContentSideInsets('pane', DUO_SIDE_INSETS)).toBe(NO_HORIZONTAL_SAFE_AREA);
  });

  it('is a no-op for the route on a portrait iPhone', () => {
    expect(playContentSideInsets('route', NO_HORIZONTAL_SAFE_AREA)).toBe(NO_HORIZONTAL_SAFE_AREA);
  });
});
