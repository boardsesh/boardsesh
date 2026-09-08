import { describe, expect, it, beforeEach } from 'vitest';
import {
  claimJoinedBrowseNotice,
  claimSoloBrowseNotice,
  JOINED_BROWSE_NOTICE_LEDGER_CAP,
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

  // A client that keeps landing in fresh session ids must not grow the ledger
  // for the life of the process. The oldest claim goes first, so the crews the
  // climber is actually in stay remembered.
  it('forgets the oldest crew once the ledger is full, and keeps the rest', () => {
    for (let index = 0; index < JOINED_BROWSE_NOTICE_LEDGER_CAP; index += 1) {
      expect(claimJoinedBrowseNotice(`session-${index}`)).toBe(true);
    }
    // Full: everything is still remembered.
    expect(claimJoinedBrowseNotice('session-0')).toBe(false);
    expect(claimJoinedBrowseNotice(`session-${JOINED_BROWSE_NOTICE_LEDGER_CAP - 1}`)).toBe(false);
    // One over: the oldest is evicted, everyone else is still remembered.
    expect(claimJoinedBrowseNotice('session-overflow')).toBe(true);
    expect(claimJoinedBrowseNotice('session-1')).toBe(false);
    expect(claimJoinedBrowseNotice('session-overflow')).toBe(false);
    // The evicted crew explains itself again — one repeated card, not a leak.
    expect(claimJoinedBrowseNotice('session-0')).toBe(true);
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
