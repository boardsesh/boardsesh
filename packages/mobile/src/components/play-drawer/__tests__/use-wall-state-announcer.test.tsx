// @vitest-environment jsdom
//
// The preview-first line (2.7, brief B1): spoken once, when the preview-first
// card makes its first show. It replaces the browse sentence for that moment
// and never adds a second sentence. Queued on iOS; a polite live region on
// Android, where announceForAccessibility is deprecated from API 36.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));
const a11y = vi.hoisted(() => ({
  announceForAccessibility: vi.fn(),
  announceForAccessibilityWithOptions: vi.fn(),
}));
const tip = vi.hoisted(() => ({ consumePreviewFirstAnnouncement: vi.fn() }));

vi.mock('react-native', () => ({
  AccessibilityInfo: a11y,
  Platform: {
    get OS() {
      return platform.OS;
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../lib/onboarding/preview-first-tip', () => tip);

const { useWallStateAnnouncer, LIVE_REGION_CLEAR_MS } = await import('../use-wall-state-announcer');
type Props = Parameters<typeof useWallStateAnnouncer>[0];

const PREVIEW_FIRST = 'playView.wallState.a11y.previewFirstAnnounce';
const BROWSE = 'playView.wallState.a11y.browseAnnounce';

/** Every sentence that reached a screen reader, by either iOS path. */
function spoken(): string[] {
  return [
    ...a11y.announceForAccessibility.mock.calls.map(([sentence]) => sentence as string),
    ...a11y.announceForAccessibilityWithOptions.mock.calls.map(([sentence]) => sentence as string),
  ];
}

function renderAnnouncer(initialProps: Props) {
  return renderHook((props: Props) => useWallStateAnnouncer(props), { initialProps });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  platform.OS = 'ios';
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useWallStateAnnouncer — the preview-first line', () => {
  it('queues it on iOS once the card shows, so it waits for VoiceOver to finish', () => {
    renderAnnouncer({ pillState: 'browsing', climbName: 'Crimp Ladder', previewFirstDue: true });
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(a11y.announceForAccessibilityWithOptions).toHaveBeenCalledWith(PREVIEW_FIRST, { queue: true });
    expect(a11y.announceForAccessibility).not.toHaveBeenCalled();
    expect(tip.consumePreviewFirstAnnouncement).toHaveBeenCalledTimes(1);
  });

  it('replaces the browse sentence of the same moment', () => {
    const { rerender } = renderAnnouncer({ pillState: null, climbName: 'Crimp Ladder' });
    rerender({ pillState: 'browsing', climbName: 'Crimp Ladder', previewFirstDue: true });
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(spoken()).toEqual([PREVIEW_FIRST]);
  });

  it('never adds a second sentence after the browse sentence already spoke', () => {
    const { rerender } = renderAnnouncer({ pillState: null, climbName: 'Crimp Ladder' });
    rerender({ pillState: 'browsing', climbName: 'Crimp Ladder' });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    rerender({ pillState: 'browsing', climbName: 'Crimp Ladder', previewFirstDue: true });
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(spoken()).toEqual([BROWSE]);
    // Spent all the same: the next open doesn't bring it back.
    expect(tip.consumePreviewFirstAnnouncement).toHaveBeenCalledTimes(1);
  });

  it('stands down when the one-shot browse notice spoke for the moment', () => {
    const { result, rerender } = renderAnnouncer({ pillState: 'browsing', climbName: 'Crimp Ladder' });
    act(() => result.current.noteBrowseNoticeSpoken());
    rerender({ pillState: 'browsing', climbName: 'Crimp Ladder', previewFirstDue: true });
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(spoken()).toEqual([]);
    expect(tip.consumePreviewFirstAnnouncement).toHaveBeenCalledTimes(1);
  });

  it('gives the moment back to the browse sentence when the card stands down first', () => {
    const { rerender } = renderAnnouncer({ pillState: null, climbName: 'Crimp Ladder' });
    rerender({ pillState: 'browsing', climbName: 'Crimp Ladder', previewFirstDue: true });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    rerender({ pillState: 'browsing', climbName: 'Crimp Ladder', previewFirstDue: false });
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(spoken()).toEqual([BROWSE]);
    expect(tip.consumePreviewFirstAnnouncement).not.toHaveBeenCalled();
  });

  it('puts it in the polite live region on Android, then empties the region', () => {
    platform.OS = 'android';
    const { result } = renderAnnouncer({ pillState: 'browsing', climbName: 'Crimp Ladder', previewFirstDue: true });
    expect(result.current.liveRegionText).toBeNull();

    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current.liveRegionText).toBe(PREVIEW_FIRST);
    expect(spoken()).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_CLEAR_MS);
    });
    expect(result.current.liveRegionText).toBeNull();
  });

  it('says nothing when the card has no line due', () => {
    renderAnnouncer({ pillState: 'browsing', climbName: 'Crimp Ladder', previewFirstDue: false });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(spoken()).toEqual([]);
  });
});
