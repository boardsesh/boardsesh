// The per-namespace purge registry (issue #4370).
//
// Before this, removing ANY board bumped one global epoch, so every other
// scope's in-flight download, the mutation-queue drain, the user-data pull and
// the deletions pull all aborted with it. These tests pin the split: a scope
// purge is invisible to everything outside its namespace, and every global path
// (sign-out, owner-stamp wipe, manual compaction) still stops everything.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  capturePurgeToken,
  hasPurgeLanded,
  beginScopePurge,
  beginGlobalPurge,
  getWipeEpoch,
  setSigningOut,
  onTeardown,
  __resetDrainerStateForTests,
} from '../drainer';
import { purgeNamespaceKey, purgeNamespaceForScopeKey } from '../../offline-board-key';

const KILTER = 'kilter:1';
const TENSION = 'tension:2';

beforeEach(() => {
  __resetDrainerStateForTests();
});

describe('beginScopePurge', () => {
  // The whole point: the drainer, the user-data pull and the deletions pull all
  // compare the GLOBAL epoch, and none of them writes a row a board teardown can
  // delete. Moving it for a board removal is what cost them a cycle each.
  it('leaves the global epoch untouched', () => {
    const before = getWipeEpoch();
    beginScopePurge(KILTER)();
    expect(getWipeEpoch()).toBe(before);
  });

  it('purges only its own namespace', () => {
    const token = capturePurgeToken();
    beginScopePurge(KILTER)();

    expect(hasPurgeLanded(token, KILTER)).toBe(true);
    expect(hasPurgeLanded(token, TENSION)).toBe(false);
    // No namespace = global-only work (the outbox, the user tables, the
    // deletions cursor), which a board removal must never abort.
    expect(hasPurgeLanded(token)).toBe(false);
  });

  // The capture-once contract: a token captured AFTER a purge is already
  // baselined past it, which is what lets the next cycle proceed normally.
  it('reads not-purged for a namespace purged BEFORE the capture', () => {
    beginScopePurge(KILTER)();
    const token = capturePurgeToken();

    expect(hasPurgeLanded(token, KILTER)).toBe(false);
  });

  // Totality of the `?? 0` fallback: a namespace nobody has ever purged needs no
  // registration, so there is no "did you remember to add this scope" footgun.
  it('reads not-purged for a namespace nobody has ever purged', () => {
    beginScopePurge(KILTER)();
    const token = capturePurgeToken();

    expect(hasPurgeLanded(token, 'moonboard:9')).toBe(false);
  });

  it('fires teardown listeners exactly once per purge', () => {
    const listener = vi.fn();
    const unsubscribe = onTeardown(listener);

    beginScopePurge(KILTER)();
    expect(listener).toHaveBeenCalledTimes(1);

    beginScopePurge(KILTER)();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

describe('the purge latch', () => {
  // removeBoardScopeData holds an exclusive transaction for seconds on a 40k-climb
  // layout. The epoch bump alone leaves a check made INSIDE that window reading
  // "no purge" whenever it captured its token after the bump — and that is exactly
  // the window a `scope-complete:` marker write must not be dispatched into.
  it('reads purged for a token captured AFTER the epoch bump, until released', () => {
    const release = beginScopePurge(KILTER);
    const midPurgeToken = capturePurgeToken();

    expect(hasPurgeLanded(midPurgeToken, KILTER)).toBe(true);
    expect(hasPurgeLanded(midPurgeToken, TENSION)).toBe(false);

    release();
    expect(hasPurgeLanded(midPurgeToken, KILTER)).toBe(false);
  });

  // Remove-all iterates the sizes of a layout, so two purges of one namespace can
  // overlap. A non-refcounted latch would let the first release unlatch the second.
  it('stays latched while a second purge of the same namespace is running', () => {
    const releaseFirst = beginScopePurge(KILTER);
    const releaseSecond = beginScopePurge(KILTER);
    const token = capturePurgeToken();

    releaseFirst();
    expect(hasPurgeLanded(token, KILTER)).toBe(true);

    releaseSecond();
    expect(hasPurgeLanded(token, KILTER)).toBe(false);
  });

  it('is idempotent, so a double release cannot unlatch a concurrent purge', () => {
    const releaseFirst = beginScopePurge(KILTER);
    const releaseSecond = beginScopePurge(KILTER);
    const token = capturePurgeToken();

    releaseFirst();
    releaseFirst();
    expect(hasPurgeLanded(token, KILTER)).toBe(true);

    releaseSecond();
    expect(hasPurgeLanded(token, KILTER)).toBe(false);
  });
});

describe('global purges', () => {
  it('beginGlobalPurge stops every namespace and every global operation', () => {
    const token = capturePurgeToken();
    beginGlobalPurge();

    expect(hasPurgeLanded(token)).toBe(true);
    expect(hasPurgeLanded(token, KILTER)).toBe(true);
    expect(hasPurgeLanded(token, TENSION)).toBe(true);
  });

  it('setSigningOut(true) stops every namespace and every global operation', () => {
    const token = capturePurgeToken();
    setSigningOut(true);

    expect(hasPurgeLanded(token)).toBe(true);
    expect(hasPurgeLanded(token, KILTER)).toBe(true);
    setSigningOut(false);
  });
});

describe('__resetDrainerStateForTests', () => {
  it('clears both the epoch map and the in-flight latches', () => {
    beginScopePurge(KILTER); // deliberately never released
    __resetDrainerStateForTests();

    const token = capturePurgeToken();
    expect(hasPurgeLanded(token, KILTER)).toBe(false);
    // A residual epoch would make a fresh token in the next test read purged the
    // moment that namespace was touched again.
    beginScopePurge(TENSION)();
    expect(hasPurgeLanded(token, KILTER)).toBe(false);
  });
});

describe('purge namespace keys', () => {
  it('is the layout, not the scope', () => {
    expect(purgeNamespaceKey({ boardType: 'kilter', layoutId: 1 })).toBe('kilter:1');
    expect(purgeNamespaceForScopeKey('kilter:1:5')).toBe('kilter:1');
  });

  // A key we cannot parse must be treated as global-only, never laundered as a
  // scope purge — we cannot prove which namespace it belongs to.
  it('is undefined for a malformed scope key', () => {
    expect(purgeNamespaceForScopeKey('kilter')).toBeUndefined();
    expect(purgeNamespaceForScopeKey('kilter:one:5')).toBeUndefined();
  });
});
