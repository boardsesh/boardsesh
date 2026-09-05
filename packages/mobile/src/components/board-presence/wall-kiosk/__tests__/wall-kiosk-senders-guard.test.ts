import { describe, expect, it } from 'vitest';
import { shouldFetchRecentSenders, type WallKioskLayout } from '../wall-kiosk-layout';

function layout(compact: boolean): WallKioskLayout {
  return { compact } as WallKioskLayout;
}

describe('shouldFetchRecentSenders', () => {
  it('fetches only when a non-compact chrome is showing a climb', () => {
    expect(shouldFetchRecentSenders(layout(false), 'live')).toBe(true);
    expect(shouldFetchRecentSenders(layout(false), 'history')).toBe(true);
  });

  it('skips the query when there is nothing to attribute or nowhere to show it', () => {
    // An idle wall has no displayed climb, and compact chrome sheds the byline —
    // neither should spend a request against the board's rate-limit budget.
    expect(shouldFetchRecentSenders(layout(false), 'idle')).toBe(false);
    expect(shouldFetchRecentSenders(layout(true), 'live')).toBe(false);
    expect(shouldFetchRecentSenders(layout(true), 'idle')).toBe(false);
    // Before the first measurement there is no layout to decide compactness on.
    expect(shouldFetchRecentSenders(null, 'live')).toBe(false);
  });
});
