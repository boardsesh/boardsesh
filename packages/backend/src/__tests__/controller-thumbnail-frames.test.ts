import { describe, expect, it } from 'vite-plus/test';
import { toThumbnailFrames } from '../graphql/resolvers/controller/subscriptions';

describe('controller thumbnail frames', () => {
  it('preserves single-frame renderer strings', () => {
    expect(toThumbnailFrames('p1r42p2r43', 'kilter')).toBe('p1r42p2r43');
  });

  // A `,"` prefix marks a delta frame; a later frame *without* the quote is
  // an absolute snapshot that restates the whole lit set (issue #3947), so
  // these cases spell the quote out rather than leaning on the old
  // everything-is-a-delta reading.
  it('unions a delta frame onto the frame it deltas from', () => {
    expect(toThumbnailFrames('p1r12,"p2r13', 'kilter')).toBe('p1r42p2r43');
  });

  it('keeps a hold a later frame turned off — the union is the whole route', () => {
    // A thumbnail can't animate, so it shows every hold the climb ever lit
    // rather than whatever survived to the last frame.
    expect(toThumbnailFrames('p1r12p2r13,"x2', 'kilter')).toBe('p1r42p2r43');
  });

  it('unions absolute frames instead of showing only the last fragment', () => {
    // Unquoted later frames are snapshots: on their own, frame 1 is just
    // hold 2. The union is the pair.
    expect(toThumbnailFrames('p1r12,p2r13', 'kilter')).toBe('p1r42p2r43');
  });

  it('lets the last frame that sets a hold win its role', () => {
    expect(toThumbnailFrames('p1r12,"p1r14', 'kilter')).toBe('p1r44');
  });
});
