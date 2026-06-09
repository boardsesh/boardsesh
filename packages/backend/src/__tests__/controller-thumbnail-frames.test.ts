import { describe, expect, it } from 'vite-plus/test';
import { toThumbnailFrames } from '../graphql/resolvers/controller/subscriptions';

describe('controller thumbnail frames', () => {
  it('preserves single-frame renderer strings', () => {
    expect(toThumbnailFrames('p1r42p2r43', 'kilter')).toBe('p1r42p2r43');
  });

  it('collapses multi-frame delta strings to the cumulative final snapshot', () => {
    expect(toThumbnailFrames('p1r12,p2r13', 'kilter')).toBe('p1r42p2r43');
  });

  it('removes holds that are off in the final frame', () => {
    expect(toThumbnailFrames('p1r12p2r13,x2', 'kilter')).toBe('p1r42');
  });
});
