import { describe, expect, it } from 'vitest';
import { createFeedPageGate, requiresCrewPageTap } from '../crew-page-state';

describe('Crew pagination', () => {
  it('requires an explicit tap only for an empty page that still has a cursor', () => {
    expect(requiresCrewPageTap({ items: [], hasMore: true })).toBe(true);
    expect(requiresCrewPageTap({ items: [], hasMore: false })).toBe(false);
    expect(requiresCrewPageTap({ items: ['climb'], hasMore: true })).toBe(false);
    expect(requiresCrewPageTap(undefined)).toBe(false);
  });
  it('allows a new feed to page while the previous feed request finishes', () => {
    const gate = createFeedPageGate();
    expect(gate.claim('crew')).toBe(true);
    expect(gate.claim('crew')).toBe(false);
    expect(gate.claim('gym:new-board')).toBe(true);
    gate.release('crew');
    expect(gate.claim('gym:new-board')).toBe(false);
    expect(gate.claim('crew')).toBe(true);
  });
});
