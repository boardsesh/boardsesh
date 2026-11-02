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

const { usePreviewFirstTip } = await import('../use-preview-first-tip');
const {
  _resetPreviewFirstTipForTests,
  consumePreviewFirstAnnouncement,
  getPreviewFirstTipState,
  retirePreviewFirstTip,
} = await import('../../../lib/onboarding/preview-first-tip');
const { _resetListCardPresenceForTests, setListCardShowing } =
  await import('../../../lib/onboarding/list-card-presence');
type Input = Parameters<typeof usePreviewFirstTip>[0];

const firstPreview: Input = { signedIn: true, boardHasLights: true, previewShowing: true, playerBusy: false };

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
