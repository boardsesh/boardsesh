import { afterEach, describe, expect, it } from 'vitest';
import { clearPlayerZoomOpen, notePlayerZoomOpen, wasPlayerZoomOpened } from '../player-zoom-presentation';

afterEach(() => clearPlayerZoomOpen());

describe('player zoom presentation', () => {
  it('reports a zoom open noted just before the player mounts', () => {
    notePlayerZoomOpen(1_000);
    expect(wasPlayerZoomOpened(1_300)).toBe(true);
  });

  it('does not mark a later open after a zoom press that never navigated', () => {
    notePlayerZoomOpen(1_000);
    expect(wasPlayerZoomOpened(3_001)).toBe(false);
  });

  it('reads as no zoom when nothing was noted or the player cleared it', () => {
    expect(wasPlayerZoomOpened()).toBe(false);
    notePlayerZoomOpen();
    clearPlayerZoomOpen();
    expect(wasPlayerZoomOpened()).toBe(false);
  });
});
