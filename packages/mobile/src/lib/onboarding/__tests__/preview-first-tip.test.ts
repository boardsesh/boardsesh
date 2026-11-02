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
  };
});
vi.mock('../onboarding-storage', () => ({ hasSeenTip: storage.hasSeenTip, markTipSeen: storage.markTipSeen }));

const {
  PREVIEW_FIRST_TIP_MAX_OPENS,
  _resetPreviewFirstTipForTests,
  claimPreviewFirstTipOpen,
  consumePreviewFirstAnnouncement,
  getPreviewFirstTipState,
  loadPreviewFirstTip,
  previewFirstAnnouncementDue,
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
  listTipShowing: false,
  playerBusy: false,
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
    expect(shouldShowPreviewFirstTip({ ...ready, listTipShowing: true })).toBe(false);
    expect(shouldShowPreviewFirstTip({ ...ready, playerBusy: true })).toBe(false);
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
  const board = (keepLighting: '30' | '45' | '60' | 'off' | 'until_stopped', isMoonboard = false) =>
    resolvePreviewFirstWindowLine({ keepLighting, moonboardKeepsLighting: 'until_stopped', isMoonboard });

  it('says the window in seconds, or as a minute', () => {
    expect(board('30')).toEqual({ key: 'windowSeconds', seconds: 30 });
    expect(board('45')).toEqual({ key: 'windowSeconds', seconds: 45 });
    expect(board('60')).toEqual({ key: 'windowMinute' });
  });

  it('says nothing more when Put on board lights one climb only', () => {
    expect(board('off')).toBeNull();
  });

  it('keeps lighting until stopped, and says so for a MoonBoard', () => {
    expect(board('until_stopped')).toEqual({ key: 'untilStop' });
    expect(board('45', true)).toEqual({ key: 'moonboard' });
  });

  it("reads a MoonBoard's own choice", () => {
    expect(
      resolvePreviewFirstWindowLine({ keepLighting: 'until_stopped', moonboardKeepsLighting: '30', isMoonboard: true }),
    ).toEqual({ key: 'windowSeconds', seconds: 30 });
  });
});
