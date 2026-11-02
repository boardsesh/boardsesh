import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The seen flag through `hasSeenTip` / `markTipSeen`, kept in a map so a "next
// app run" (a store reset) reads back what the last one wrote.
const storage = vi.hoisted(() => {
  const seen = new Set<string>();
  return {
    seen,
    hasSeenTip: vi.fn(async (key: string) => seen.has(key)),
    markTipSeen: vi.fn(async (key: string) => {
      seen.add(key);
    }),
    clearTipSeen: vi.fn(async (key: string) => {
      seen.delete(key);
    }),
  };
});
vi.mock('../onboarding-storage', () => ({
  hasSeenTip: storage.hasSeenTip,
  markTipSeen: storage.markTipSeen,
  clearTipSeen: storage.clearTipSeen,
}));

const {
  PREVIEW_FIRST_TIP_MAX_OPENS,
  _resetPreviewFirstTipForTests,
  claimPreviewFirstTipOpen,
  consumePreviewFirstAnnouncement,
  forgetPreviewFirstTip,
  getPreviewFirstTipState,
  loadPreviewFirstTip,
  previewFirstAnnouncementDue,
  previewFirstTipRetiredByDrive,
  resolvePreviewFirstFrostLine,
  resolvePreviewFirstWindowLine,
  retirePreviewFirstTip,
  shouldShowPreviewFirstTip,
} = await import('../preview-first-tip');
type GateInput = Parameters<typeof shouldShowPreviewFirstTip>[0];

const KEY = 'onboarding_tip_preview_first_seen';

/** Let the lazily imported storage and its read settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  storage.seen.clear();
  vi.clearAllMocks();
  _resetPreviewFirstTipForTests();
});
afterEach(() => {
  _resetPreviewFirstTipForTests();
});

const ready: GateInput = {
  state: { status: 'unseen', opens: 0, announcePending: false },
  claimedThisOpen: false,
  signedIn: true,
  boardHasLights: true,
  previewShowing: true,
  connectCardVisible: false,
  connectConfirmationShowing: false,
  listTipShowing: false,
  playerBusy: false,
  slotInView: true,
  screenshotMode: false,
};

describe('shouldShowPreviewFirstTip', () => {
  it('shows on the first preview on a board with lights, signed in', () => {
    expect(shouldShowPreviewFirstTip(ready)).toBe(true);
  });

  it('never shows on a board without lights, signed out, or in screenshot mode', () => {
    expect(shouldShowPreviewFirstTip({ ...ready, boardHasLights: false })).toBe(false);
    expect(shouldShowPreviewFirstTip({ ...ready, signedIn: false })).toBe(false);
    expect(shouldShowPreviewFirstTip({ ...ready, screenshotMode: true })).toBe(false);
  });

  it('waits for a preview: the climb on the wall is not the moment it explains', () => {
    expect(shouldShowPreviewFirstTip({ ...ready, previewShowing: false })).toBe(false);
  });

  it('yields to the first-connect card, the list tips and anything asking in the player', () => {
    expect(shouldShowPreviewFirstTip({ ...ready, connectCardVisible: true })).toBe(false);
    expect(shouldShowPreviewFirstTip({ ...ready, connectConfirmationShowing: true })).toBe(false);
    expect(shouldShowPreviewFirstTip({ ...ready, listTipShowing: true })).toBe(false);
    expect(shouldShowPreviewFirstTip({ ...ready, playerBusy: true })).toBe(false);
  });

  // Below the fold it would spend its seen flag and its screen-reader line unseen.
  it('waits for its slot under the board to be on the first screen', () => {
    expect(shouldShowPreviewFirstTip({ ...ready, slotInView: false })).toBe(false);
    expect(
      shouldShowPreviewFirstTip({
        ...ready,
        slotInView: false,
        claimedThisOpen: true,
        state: { status: 'showing', opens: 1, announcePending: false },
      }),
    ).toBe(false);
  });

  it('waits for the seen flag, and stays away once retired', () => {
    expect(shouldShowPreviewFirstTip({ ...ready, state: { ...ready.state, status: 'unknown' } })).toBe(false);
    expect(shouldShowPreviewFirstTip({ ...ready, state: { ...ready.state, status: 'retired' } })).toBe(false);
  });

  it('comes back on a later open of the same run until it runs out of opens', () => {
    const showing = { status: 'showing' as const, opens: PREVIEW_FIRST_TIP_MAX_OPENS - 1, announcePending: false };
    expect(shouldShowPreviewFirstTip({ ...ready, state: showing })).toBe(true);
    expect(shouldShowPreviewFirstTip({ ...ready, state: { ...showing, opens: PREVIEW_FIRST_TIP_MAX_OPENS } })).toBe(
      false,
    );
  });

  it('stays for the rest of an open that showed it, preview or not, until something else needs the slot', () => {
    const claimed: GateInput = {
      ...ready,
      state: { status: 'showing', opens: PREVIEW_FIRST_TIP_MAX_OPENS, announcePending: false },
      claimedThisOpen: true,
      previewShowing: false,
    };
    expect(shouldShowPreviewFirstTip(claimed)).toBe(true);
    expect(shouldShowPreviewFirstTip({ ...claimed, playerBusy: true })).toBe(false);
    expect(shouldShowPreviewFirstTip({ ...claimed, state: { ...claimed.state, status: 'retired' } })).toBe(false);
  });
});

describe('the seen flag', () => {
  it('reads unseen on a device that never showed it', async () => {
    await loadPreviewFirstTip();
    expect(getPreviewFirstTipState().status).toBe('unseen');
    expect(storage.hasSeenTip).toHaveBeenCalledWith(KEY);
  });

  it('writes the flag the first time it shows and queues the screen-reader line', async () => {
    await loadPreviewFirstTip();
    expect(claimPreviewFirstTipOpen()).toBe(true);
    await settle();

    expect(getPreviewFirstTipState()).toEqual({ status: 'showing', opens: 1, announcePending: true });
    expect(storage.markTipSeen).toHaveBeenCalledTimes(1);
    expect(storage.markTipSeen).toHaveBeenCalledWith(KEY);
  });

  it('never shows on the next app run, once it has shown', async () => {
    await loadPreviewFirstTip();
    claimPreviewFirstTipOpen();
    await settle();

    // A cold start: the in-memory store is gone, the flag is not.
    _resetPreviewFirstTipForTests();
    await loadPreviewFirstTip();

    expect(getPreviewFirstTipState().status).toBe('retired');
    expect(claimPreviewFirstTipOpen()).toBe(false);
  });

  it('shows on at most three opens of the run, and queues the line on the first only', async () => {
    await loadPreviewFirstTip();
    expect(claimPreviewFirstTipOpen()).toBe(true);
    consumePreviewFirstAnnouncement();
    expect(claimPreviewFirstTipOpen()).toBe(true);
    expect(claimPreviewFirstTipOpen()).toBe(true);
    expect(getPreviewFirstTipState()).toEqual({ status: 'showing', opens: 3, announcePending: false });
    expect(claimPreviewFirstTipOpen()).toBe(false);
  });

  it('retires for good on an exit, dropping a line not yet spoken', async () => {
    await loadPreviewFirstTip();
    claimPreviewFirstTipOpen();
    retirePreviewFirstTip();
    await settle();

    expect(getPreviewFirstTipState()).toMatchObject({ status: 'retired', announcePending: false });
    expect(claimPreviewFirstTipOpen()).toBe(false);
    expect(storage.seen.has(KEY)).toBe(true);
  });

  it('shows again after Replay walkthrough forgets it', async () => {
    await loadPreviewFirstTip();
    expect(claimPreviewFirstTipOpen()).toBe(true);
    retirePreviewFirstTip();
    await settle();
    expect(getPreviewFirstTipState().status).toBe('retired');
    await forgetPreviewFirstTip();
    expect(storage.clearTipSeen).toHaveBeenCalledWith(KEY);
    expect(getPreviewFirstTipState().status).toBe('unknown');
    await loadPreviewFirstTip();
    expect(getPreviewFirstTipState().status).toBe('unseen');
  });

  it('reads a store that cannot be read as seen, so it never nags', async () => {
    storage.hasSeenTip.mockRejectedValueOnce(new Error('keychain locked'));
    await loadPreviewFirstTip();
    expect(getPreviewFirstTipState().status).toBe('retired');
  });

  it('reads the flag once per run', async () => {
    await Promise.all([loadPreviewFirstTip(), loadPreviewFirstTip()]);
    await loadPreviewFirstTip();
    expect(storage.hasSeenTip).toHaveBeenCalledTimes(1);
  });
});

describe('previewFirstAnnouncementDue', () => {
  it('belongs to the first-ever show, before and after the claim, and only while the card is up', () => {
    expect(previewFirstAnnouncementDue({ status: 'unseen', opens: 0, announcePending: false }, true)).toBe(true);
    expect(previewFirstAnnouncementDue({ status: 'showing', opens: 1, announcePending: true }, true)).toBe(true);
    expect(previewFirstAnnouncementDue({ status: 'showing', opens: 1, announcePending: true }, false)).toBe(false);
  });

  it('is spent once spoken: a later open of the run says nothing', () => {
    expect(previewFirstAnnouncementDue({ status: 'showing', opens: 2, announcePending: false }, true)).toBe(false);
  });
});

describe('resolvePreviewFirstWindowLine', () => {
  const plan = (windowMs: number | null) => ({ windowMs, setting: 'putOnBoardKeepsLighting' as const });

  it('says the window in seconds, or as a minute', () => {
    expect(resolvePreviewFirstWindowLine({ plan: plan(30_000) })).toEqual({
      key: 'windowSeconds',
      seconds: 30,
    });
    expect(resolvePreviewFirstWindowLine({ plan: plan(45_000) })).toEqual({
      key: 'windowSeconds',
      seconds: 45,
    });
    expect(resolvePreviewFirstWindowLine({ plan: plan(60_000) })).toEqual({ key: 'windowMinute' });
  });

  // Off, or a press that can't open a window here (a session with In a session
  // too off): the press lights one climb, which the headline already says.
  it('says nothing more when Put on board lights one climb only', () => {
    expect(resolvePreviewFirstWindowLine({ plan: null })).toBeNull();
  });

  // A MoonBoard takes the same Stop driving after, so it reads the same line.
  it('keeps lighting until stopped', () => {
    expect(resolvePreviewFirstWindowLine({ plan: plan(null) })).toEqual({ key: 'untilStop' });
  });

  // Where Always drive the wall drives, Put on board resumes its drive with no
  // end (the wall control's `tapDrive: 'resume'`), whatever Stop driving after
  // says: the card promises driving until you stop.
  it('names driving until you stop where Always drive the wall drives', () => {
    expect(resolvePreviewFirstWindowLine({ plan: plan(45_000), alwaysDrive: true })).toEqual({
      key: 'untilStop',
    });
    expect(resolvePreviewFirstWindowLine({ plan: null, alwaysDrive: true })).toEqual({
      key: 'untilStop',
    });
    expect(resolvePreviewFirstWindowLine({ plan: plan(null), alwaysDrive: true })).toEqual({
      key: 'untilStop',
    });
  });

  it('says whole minutes in minutes', () => {
    expect(resolvePreviewFirstWindowLine({ plan: plan(60_000) })).toEqual({ key: 'windowMinute' });
    expect(resolvePreviewFirstWindowLine({ plan: plan(120_000) })).toEqual({
      key: 'windowMinutes',
      minutes: 2,
    });
    expect(resolvePreviewFirstWindowLine({ plan: plan(300_000) })).toEqual({
      key: 'windowMinutes',
      minutes: 5,
    });
  });
});

// The frost sentence follows the same reach as the second line: a clock only
// where Put on board's drive has one.
describe('resolvePreviewFirstFrostLine', () => {
  const plan = (windowMs: number | null) => ({ windowMs, setting: 'putOnBoardKeepsLighting' as const });

  it('names the clock for a timed drive, whatever its length', () => {
    for (const windowMs of [30_000, 45_000, 60_000, 120_000, 300_000]) {
      expect(resolvePreviewFirstFrostLine({ plan: plan(windowMs) })).toBe('timed');
    }
  });

  it('names none for Until I stop, Right away, or where Always drive the wall drives', () => {
    expect(resolvePreviewFirstFrostLine({ plan: plan(null) })).toBe('open_ended');
    expect(resolvePreviewFirstFrostLine({ plan: null })).toBe('open_ended');
    expect(resolvePreviewFirstFrostLine({ plan: plan(45_000), alwaysDrive: true })).toBe('open_ended');
  });
});

describe('previewFirstTipRetiredByDrive', () => {
  const SHOWN_AT = 1_000;
  const swipe = { startedAt: SHOWN_AT + 1, openEnded: true };
  const timedWindow = { startedAt: SHOWN_AT + 1, openEnded: false };

  it('retires on an open-ended drive started after it showed', () => {
    expect(previewFirstTipRetiredByDrive({ drive: swipe, previous: null, shownAt: SHOWN_AT })).toBe(true);
    expect(
      previewFirstTipRetiredByDrive({ drive: { ...swipe, startedAt: SHOWN_AT }, previous: null, shownAt: SHOWN_AT }),
    ).toBe(true);
  });

  // The window is what the card describes.
  it("stays through Put on board's timed window", () => {
    expect(previewFirstTipRetiredByDrive({ drive: timedWindow, previous: null, shownAt: SHOWN_AT })).toBe(false);
    expect(previewFirstTipRetiredByDrive({ drive: null, previous: timedWindow, shownAt: SHOWN_AT })).toBe(false);
  });

  it('ignores a drive that was already open-ended when it showed', () => {
    const earlier = { startedAt: SHOWN_AT - 1, openEnded: true };
    expect(previewFirstTipRetiredByDrive({ drive: earlier, previous: null, shownAt: SHOWN_AT })).toBe(false);
    expect(previewFirstTipRetiredByDrive({ drive: earlier, previous: earlier, shownAt: SHOWN_AT })).toBe(false);
  });

  // A swipe or Light every climb during a window makes the same drive open-ended.
  it('retires when a window that was running before it showed turns open-ended', () => {
    const before = { startedAt: SHOWN_AT - 1, openEnded: false };
    expect(
      previewFirstTipRetiredByDrive({ drive: { ...before, openEnded: true }, previous: before, shownAt: SHOWN_AT }),
    ).toBe(true);
    // A different drive that happens to be open-ended is not that window turning.
    expect(
      previewFirstTipRetiredByDrive({
        drive: { startedAt: SHOWN_AT - 2, openEnded: true },
        previous: before,
        shownAt: SHOWN_AT,
      }),
    ).toBe(false);
  });
});
