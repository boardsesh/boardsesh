// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const storage = vi.hoisted(() => {
  const flag = { seen: false };
  return {
    flag,
    hasSeenTip: vi.fn(async (): Promise<boolean> => flag.seen),
    markTipSeen: vi.fn(async (): Promise<void> => undefined),
  };
});
vi.mock('../../../lib/onboarding/onboarding-storage', () => ({
  hasSeenTip: () => storage.hasSeenTip(),
  markTipSeen: () => storage.markTipSeen(),
}));

const { resolvePreviewFirstTipInput, usePreviewFirstTip } = await import('../use-preview-first-tip');
const {
  PREVIEW_FIRST_TIP_MAX_OPENS,
  _resetPreviewFirstTipForTests,
  consumePreviewFirstAnnouncement,
  getPreviewFirstTipState,
  retirePreviewFirstTip,
} = await import('../../../lib/onboarding/preview-first-tip');
const { _resetListCardPresenceForTests, setListCardShowing } =
  await import('../../../lib/onboarding/list-card-presence');
const { _resetFirstConnectConfirmationPresenceForTests, setFirstConnectConfirmationShowing } =
  await import('../../../lib/onboarding/first-connect-confirmation-presence');
type Input = Parameters<typeof usePreviewFirstTip>[0];

const firstPreview: Input = {
  signedIn: true,
  boardHasLights: true,
  previewShowing: true,
  playerBusy: false,
  slotInView: true,
  openKey: 1,
};

/** Render the hook and let the seen flag's read land. */
async function renderTip(input: Input = firstPreview) {
  const rendered = renderHook((props: Input) => usePreviewFirstTip(props), { initialProps: input });
  await waitFor(() => expect(getPreviewFirstTipState().status).not.toBe('unknown'));
  return rendered;
}

beforeEach(() => {
  storage.flag.seen = false;
  vi.clearAllMocks();
  _resetPreviewFirstTipForTests();
  _resetListCardPresenceForTests();
  _resetFirstConnectConfirmationPresenceForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('usePreviewFirstTip', () => {
  it('shows on the first preview, counts this open once, and owns the screen-reader line', async () => {
    const { result } = await renderTip();

    expect(result.current.visible).toBe(true);
    expect(result.current.announcementDue).toBe(true);
    expect(getPreviewFirstTipState()).toMatchObject({ status: 'showing', opens: 1 });
    expect(storage.markTipSeen).toHaveBeenCalledTimes(1);
  });

  it('stays for the rest of the open after the climb is put on the wall', async () => {
    const { result, rerender } = await renderTip();
    rerender({ ...firstPreview, previewShowing: false });

    expect(result.current.visible).toBe(true);
    expect(getPreviewFirstTipState().opens).toBe(1);
  });

  it('never shows to a climber who saw it on an earlier run', async () => {
    storage.flag.seen = true;
    const { result } = await renderTip();

    expect(result.current.visible).toBe(false);
    expect(result.current.announcementDue).toBe(false);
  });

  it('waits for a preview on a board with lights', async () => {
    const { result, rerender } = await renderTip({ ...firstPreview, previewShowing: false });
    expect(result.current.visible).toBe(false);
    rerender({ ...firstPreview, boardHasLights: false });
    expect(result.current.visible).toBe(false);
    expect(getPreviewFirstTipState().status).toBe('unseen');

    rerender(firstPreview);
    expect(result.current.visible).toBe(true);
  });

  // One card at a time (the quick-actions-tip rule): beside a tablet's player
  // pane the Climbs list's cards are on screen too.
  it('yields to the first-connect card and the Climbs list tips without spending an open', async () => {
    for (const card of ['firstConnect', 'boardReveal', 'quickActions'] as const) {
      setListCardShowing(card, true);
      const { result, unmount } = await renderTip();
      expect(result.current.visible).toBe(false);
      unmount();
      setListCardShowing(card, false);
    }
    expect(getPreviewFirstTipState()).toMatchObject({ status: 'unseen', opens: 0 });
  });

  // Both say what Put on board keeps lighting: never the two at once.
  it('waits out the first-connect confirmation without spending an open, then shows', async () => {
    setFirstConnectConfirmationShowing(true);
    const { result } = await renderTip();
    expect(result.current.visible).toBe(false);
    expect(getPreviewFirstTipState()).toMatchObject({ status: 'unseen', opens: 0 });

    act(() => setFirstConnectConfirmationShowing(false));
    expect(result.current.visible).toBe(true);
    expect(getPreviewFirstTipState()).toMatchObject({ status: 'showing', opens: 1 });
  });

  it('steps aside for a confirmation that comes up while it shows, and comes back after', async () => {
    const { result } = await renderTip();
    expect(result.current.visible).toBe(true);

    act(() => setFirstConnectConfirmationShowing(true));
    expect(result.current.visible).toBe(false);

    act(() => setFirstConnectConfirmationShowing(false));
    expect(result.current.visible).toBe(true);
    expect(getPreviewFirstTipState().opens).toBe(1);
  });

  it('steps aside while the player is asking something, and comes back after', async () => {
    const { result, rerender } = await renderTip();
    rerender({ ...firstPreview, playerBusy: true });
    expect(result.current.visible).toBe(false);

    rerender(firstPreview);
    expect(result.current.visible).toBe(true);
    expect(getPreviewFirstTipState().opens).toBe(1);
  });

  it('says it is deciding while the flag is read and the card could show', () => {
    const { result } = renderHook(() => usePreviewFirstTip(firstPreview));
    expect(result.current.deciding).toBe(true);
    expect(result.current.visible).toBe(false);
  });

  it('does not hold anything up where it could never show', () => {
    const { result } = renderHook(() => usePreviewFirstTip({ ...firstPreview, signedIn: false }));
    expect(result.current.deciding).toBe(false);
  });

  it('speaks its line on the first open only', async () => {
    const first = await renderTip();
    act(() => consumePreviewFirstAnnouncement());
    expect(first.result.current.announcementDue).toBe(false);
    first.unmount();

    const second = renderHook(() => usePreviewFirstTip(firstPreview));
    expect(second.result.current.visible).toBe(true);
    expect(second.result.current.announcementDue).toBe(false);
    expect(getPreviewFirstTipState().opens).toBe(2);
  });

  // The iPad pane stays mounted, so its mount is not the open: each climb
  // opened into it is, and the card's limit applies there too.
  it('counts each climb opened into a mounted pane as an open, up to the limit', async () => {
    const { result, rerender } = await renderTip();
    expect(getPreviewFirstTipState().opens).toBe(1);

    for (let openKey = 2; openKey <= PREVIEW_FIRST_TIP_MAX_OPENS; openKey += 1) {
      rerender({ ...firstPreview, openKey });
      expect(result.current.visible).toBe(true);
      expect(getPreviewFirstTipState().opens).toBe(openKey);
    }
    rerender({ ...firstPreview, openKey: PREVIEW_FIRST_TIP_MAX_OPENS + 1 });
    expect(result.current.visible).toBe(false);
  });

  it('stays put while the same open re-renders', async () => {
    const { result, rerender } = await renderTip();
    rerender({ ...firstPreview });
    rerender({ ...firstPreview, previewShowing: false });
    expect(result.current.visible).toBe(true);
    expect(getPreviewFirstTipState().opens).toBe(1);
  });

  it('never spends itself below the fold', async () => {
    const { result } = await renderTip({ ...firstPreview, slotInView: false });
    expect(result.current.visible).toBe(false);
    expect(result.current.announcementDue).toBe(false);
    expect(getPreviewFirstTipState()).toMatchObject({ status: 'unseen', opens: 0 });
    expect(storage.markTipSeen).not.toHaveBeenCalled();
  });

  it('goes for good on an exit', async () => {
    const { result } = await renderTip();
    act(() => retirePreviewFirstTip());
    expect(result.current.visible).toBe(false);
  });

  it('never shows in screenshot mode', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    const { result } = await renderTip();
    expect(result.current.visible).toBe(false);
    expect(result.current.deciding).toBe(false);
  });
});

describe('resolvePreviewFirstTipInput', () => {
  type Player = Parameters<typeof resolvePreviewFirstTipInput>[0];
  // A preview on this phone's own board, connected, with the sections under it.
  const player: Player = {
    signedIn: true,
    playerHasWall: true,
    wallControl: { state: 'put_on_wall', holder: 'self', labelKey: 'putOnBoard' },
    isPreview: true,
    displayedLit: false,
    busyWallUp: false,
    workoutOutcomeUp: false,
    boardMismatchUp: false,
    trackEndCardUp: false,
    hasVisibleSections: true,
    tabletop: false,
    fitsBoardToHeight: false,
    openKey: 7,
  };

  it('is ready on a preview of a board this phone can light', () => {
    expect(resolvePreviewFirstTipInput(player)).toEqual({
      signedIn: true,
      boardHasLights: true,
      previewShowing: true,
      playerBusy: false,
      slotInView: true,
      openKey: 7,
    });
    // Not linked yet, but Put on board connects.
    expect(
      resolvePreviewFirstTipInput({
        ...player,
        wallControl: { state: 'connect', holder: null, labelKey: 'putOnBoard' },
      }).boardHasLights,
    ).toBe(true);
  });

  // Spec B5: never on Set active, a spray wall or a board with no lights.
  it('has no board with lights on Set active, spray, no-lights boards or with nothing to offer', () => {
    const lights = (overrides: Partial<Player>) =>
      resolvePreviewFirstTipInput({ ...player, ...overrides }).boardHasLights;
    expect(lights({ wallControl: { state: 'put_on_wall', holder: null, labelKey: 'setActive' } })).toBe(false);
    expect(lights({ playerHasWall: false })).toBe(false);
    expect(lights({ wallControl: { state: 'take_wall', holder: null, labelKey: 'takeWall' } })).toBe(false);
    expect(lights({ wallControl: { state: 'release_wall', holder: 'self', labelKey: 'releaseWall' } })).toBe(false);
    expect(lights({ wallControl: { state: null, holder: null, labelKey: null } })).toBe(false);
  });

  // A crewmate's phone lights it: there is no frost here and no window to open.
  it('has no board with lights for a crew relay', () => {
    expect(
      resolvePreviewFirstTipInput({
        ...player,
        wallControl: { state: 'put_on_wall', holder: 'crew', labelKey: 'putOnBoard' },
      }).boardHasLights,
    ).toBe(false);
  });

  it('is a preview only while the climb on screen is not the lit one', () => {
    expect(resolvePreviewFirstTipInput({ ...player, displayedLit: true }).previewShowing).toBe(false);
    expect(resolvePreviewFirstTipInput({ ...player, isPreview: false }).previewShowing).toBe(false);
  });

  // Never stacked with the busy-wall question, a card over the board or Fell / Sent.
  it('is busy while anything else in the player is asking', () => {
    for (const busy of ['busyWallUp', 'workoutOutcomeUp', 'boardMismatchUp', 'trackEndCardUp'] as const) {
      expect(resolvePreviewFirstTipInput({ ...player, [busy]: true }).playerBusy).toBe(true);
    }
  });

  it('has its slot in view only where the sections peek on the first screen', () => {
    const slot = (overrides: Partial<Player>) => resolvePreviewFirstTipInput({ ...player, ...overrides }).slotInView;
    expect(slot({ hasVisibleSections: false })).toBe(false);
    expect(slot({ fitsBoardToHeight: true })).toBe(false);
    // The tabletop's sections start in view, under the controls.
    expect(slot({ tabletop: true, hasVisibleSections: false })).toBe(true);
  });
});
