import { describe, expect, it, beforeEach } from 'vitest';
import {
  claimJoinedBrowseNotice,
  claimSoloBrowseNotice,
  _resetJoinedBrowseNoticeForTests,
} from '../joined-browse-notice';
import { resetAllSettings } from '../../../settings';

beforeEach(() => {
  _resetJoinedBrowseNoticeForTests();
  resetAllSettings();
});

describe('claimJoinedBrowseNotice', () => {
  it('grants the notice exactly once per session', () => {
    expect(claimJoinedBrowseNotice('session-1')).toBe(true);
    expect(claimJoinedBrowseNotice('session-1')).toBe(false);
    expect(claimJoinedBrowseNotice('session-1')).toBe(false);
  });

  // The claim lives in module state precisely so it survives the play drawer
  // unmounting — it is a modal route, and a ref inside it would reset on every
  // dismiss, re-showing the card each time the drawer opened.
  it('explains a different crew again', () => {
    expect(claimJoinedBrowseNotice('session-1')).toBe(true);
    expect(claimJoinedBrowseNotice('session-2')).toBe(true);
    expect(claimJoinedBrowseNotice('session-2')).toBe(false);
  });

  it('never claims solo — the solo rule has its own claim', () => {
    expect(claimJoinedBrowseNotice(null)).toBe(false);
    expect(claimJoinedBrowseNotice(null)).toBe(false);
    // And a null claim must not consume a later real session's one shot.
    expect(claimJoinedBrowseNotice('session-1')).toBe(true);
  });
});

// The other half: a climber who turned board lighting off for swipes and taps
// navigates view-only too, and nothing else says so.
describe('claimSoloBrowseNotice', () => {
  it('grants the notice exactly once', () => {
    expect(claimSoloBrowseNotice()).toBe(true);
    expect(claimSoloBrowseNotice()).toBe(false);
  });

  // Persisted, unlike the crew claim: the setting behind it survives app death,
  // so an in-memory claim would re-explain it on every cold start.
  it('stays claimed across a fresh module state', () => {
    expect(claimSoloBrowseNotice()).toBe(true);
    _resetJoinedBrowseNoticeForTests();
    expect(claimSoloBrowseNotice()).toBe(false);
  });

  it('does not consume a crew session’s own one shot', () => {
    expect(claimSoloBrowseNotice()).toBe(true);
    expect(claimJoinedBrowseNotice('session-1')).toBe(true);
  });
});
