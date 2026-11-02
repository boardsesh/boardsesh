// @vitest-environment jsdom
//
// The preview-first card (2.7, brief B5). The copy is the en-US catalog itself,
// so a renamed or missing key fails here instead of rendering a raw key. The
// sample button is the real model the player draws while driving; the button's
// own drawing has its suite.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import commonCatalog from '@boardsesh/i18n/locales/en-US/common.json';

type Children = { children?: ReactNode };
type Props = Record<string, unknown>;

const recorded = vi.hoisted(() => ({ wallButton: [] as Record<string, unknown>[] }));
const screenReader = vi.hoisted(() => ({ enabled: false }));
const windowSize = vi.hoisted(() => ({ fontScale: 1 }));
const drive = vi.hoisted(() => {
  type Drive = { startedAt: number; startedBy: string; windowMs: number | null } | null;
  const listeners = new Set<() => void>();
  const store = {
    current: null as Drive,
    set(next: Drive) {
      store.current = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return store;
});

// Every accessibility and touch prop the card sets on a View lands on the DOM,
// so a case can read what a screen reader and a finger would get.
vi.mock('react-native', () => ({
  View: ({
    children,
    testID,
    pointerEvents,
    accessible,
    accessibilityElementsHidden,
    importantForAccessibility,
    accessibilityIgnoresInvertColors,
  }: Children & {
    testID?: string;
    pointerEvents?: string;
    accessible?: boolean;
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: string;
    accessibilityIgnoresInvertColors?: boolean;
  }) =>
    createElement(
      'div',
      {
        'data-testid': testID,
        'data-pointer-events': pointerEvents,
        'data-accessible': accessible === undefined ? undefined : String(accessible),
        'data-a11y-hidden': accessibilityElementsHidden === undefined ? undefined : String(accessibilityElementsHidden),
        'data-important-for-a11y': importantForAccessibility,
        'data-ignores-invert':
          accessibilityIgnoresInvertColors === undefined ? undefined : String(accessibilityIgnoresInvertColors),
      },
      children,
    ),
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios ?? spec.default },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: ({ light }: { light: string }) => light,
  useWindowDimensions: () => ({ width: 390, height: 844, fontScale: windowSize.fontScale }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const found = key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
          commonCatalog,
        );
      if (typeof found !== 'string') return key;
      return found.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''));
    },
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, accessibilityRole, testID }: Children & { accessibilityRole?: string; testID?: string }) =>
    createElement(accessibilityRole === 'header' ? 'h2' : 'span', { 'data-testid': testID }, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../Button', () => ({
  Button: ({
    title,
    onPress,
    testID,
    minHeight,
  }: {
    title: string;
    onPress: () => void;
    testID?: string;
    minHeight?: number;
  }) =>
    createElement(
      'button',
      { type: 'button', onClick: onPress, 'data-testid': testID, 'data-min-height': minHeight },
      title,
    ),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, accessibilityLabel, testID }: Children & Props) =>
    createElement(
      'button',
      { type: 'button', onClick: onPress as () => void, 'aria-label': accessibilityLabel, 'data-testid': testID },
      children,
    ),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primary: '#6D28D9' },
    systemColors: { label: '#111', secondaryLabel: '#666' },
  }),
}));
vi.mock('../../../hooks/use-screen-reader-enabled', () => ({ useScreenReaderEnabled: () => screenReader.enabled }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { displayName: 'Marco', avatarUrl: 'https://example.com/marco.png' } }),
}));
vi.mock('../../play-drawer/WallControlButton', () => ({
  WallControlButton: (props: Props) => {
    recorded.wallButton.push(props);
    return createElement('div', { 'data-testid': 'wall-control-sample' });
  },
}));
vi.mock('../../play-drawer/drive-mode-store', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useDriveMode: () =>
      useSyncExternalStore(
        (listener) => drive.subscribe(listener),
        () => drive.current,
      ),
  };
});

const { PlayerPreviewTip, buildDrivingSampleModel } = await import('../PlayerPreviewTip');
const { wallControlUsesFrost } = await import('../../play-drawer/wall-control-frost');

const tips = commonCatalog.mobile.onboarding.tips.previewFirst;
const GLOW = { key: 'climb-1', holds: [{ x: 10, y: 10, color: '#00DD00' }], boardWidth: 100, boardHeight: 100 };

/** Put on board's plan at the default: a 45 s window. */
const WINDOW_45 = { windowMs: 45_000, setting: 'putOnBoardKeepsLighting' } as const;
const UNTIL_STOPPED = { windowMs: null, setting: 'putOnBoardKeepsLighting' } as const;

function renderTip(props: Partial<Parameters<typeof PlayerPreviewTip>[0]> = {}) {
  const onExit = vi.fn();
  render(createElement(PlayerPreviewTip, { glow: GLOW, keepLighting: WINDOW_45, onExit, ...props }));
  return onExit;
}

beforeEach(() => {
  recorded.wallButton = [];
  screenReader.enabled = false;
  windowSize.fontScale = 1;
  drive.current = null;
});
afterEach(() => cleanup());

describe('PlayerPreviewTip', () => {
  it('says what changed, and what the frost means', () => {
    renderTip();
    expect(screen.getByRole('heading').textContent).toBe(tips.title);
    expect(screen.getByTestId('player-preview-tip-window').textContent).toBe(
      tips.windowSeconds.replace('{{seconds}}', '45'),
    );
    expect(screen.getByTestId('player-preview-tip-frost').textContent).toBe(tips.frost);
  });

  it('draws the real wall button, frosted and driving, in this climb’s colours', () => {
    renderTip();
    const sample = recorded.wallButton.at(-1);
    if (!sample) throw new Error('The sample button never rendered');
    const model = sample.model as ReturnType<typeof buildDrivingSampleModel>;
    expect(model.labelKey).toBe('youAreDriving');
    expect(wallControlUsesFrost(model)).toBe(true);
    expect(model.holderFace).toEqual({ name: 'Marco', avatarUrl: 'https://example.com/marco.png' });
    expect(sample.glow).toBe(GLOW);
    // No swipe, so no chevrons, no peek and no gesture on the picture.
    expect(sample.onSwipe).toBeUndefined();
    expect(model.swipeAction).toBeNull();
    // A picture: no testIDs, so a test or Maestro only finds the real button.
    expect(sample.sample).toBe(true);
  });

  it('falls back to the flat driving amber with no holds to frost', () => {
    renderTip({ glow: null });
    expect(recorded.wallButton.at(-1)?.glow).toBeNull();
  });

  // The picture is decoration: the copy carries its meaning.
  it('hides the sample from screen readers and touches, and from Smart Invert', () => {
    renderTip();
    const sample = screen.getByTestId('player-preview-tip-sample');
    expect(sample.dataset.pointerEvents).toBe('none');
    expect(sample.dataset.accessible).toBe('false');
    expect(sample.dataset.a11yHidden).toBe('true');
    expect(sample.dataset.importantForA11y).toBe('no-hide-descendants');
    expect(sample.dataset.ignoresInvert).toBe('true');
    expect(sample.contains(screen.getByTestId('wall-control-sample'))).toBe(true);
  });

  it('names the label and the gesture-free action to a screen reader instead of the glow', () => {
    screenReader.enabled = true;
    renderTip();
    expect(screen.getByTestId('player-preview-tip-frost').textContent).toBe(tips.frostScreenReader);
  });

  it('says what happens after Put on board for the setting on this board', () => {
    renderTip({ keepLighting: { windowMs: 60_000, setting: 'putOnBoardKeepsLighting' } });
    expect(screen.getByTestId('player-preview-tip-window').textContent).toBe(tips.windowMinute);
    cleanup();
    // 2 and 5 minutes are said in minutes, never as 120 or 300 seconds.
    renderTip({ keepLighting: { windowMs: 300_000, setting: 'putOnBoardKeepsLighting' } });
    expect(screen.getByTestId('player-preview-tip-window').textContent).toBe(
      tips.windowMinutes.replace('{{minutes}}', '5'),
    );
    cleanup();
    renderTip({ keepLighting: UNTIL_STOPPED });
    expect(screen.getByTestId('player-preview-tip-window').textContent).toBe(tips.untilStop);
    cleanup();
    // Off, or a press that can't open a window here.
    renderTip({ keepLighting: null });
    expect(screen.queryByTestId('player-preview-tip-window')).toBeNull();
  });

  // The setting Put on board's plan does not take (`resolveKeepLightingReach`):
  // where Always drive the wall drives, Put on board drives until you stop.
  it('reads Always drive the wall the way the press does', () => {
    renderTip({ alwaysDrive: true });
    expect(screen.getByTestId('player-preview-tip-window').textContent).toBe(tips.untilStop);
  });

  // The frost sentence names a clock only where Put on board's drive has one:
  // never on Until I stop, Right away, or where the press starts no drive.
  it.each([
    ['Until I stop', { keepLighting: UNTIL_STOPPED }],
    ['Right away, or no drive in a session', { keepLighting: null }],
    ['Always drive the wall', { alwaysDrive: true }],
  ] as const)('says the frost means driving until you stop, with no clock, for %s', (_case, props) => {
    renderTip(props);
    expect(screen.getByTestId('player-preview-tip-frost').textContent).toBe(tips.frostOpenEnded);
    cleanup();
    screenReader.enabled = true;
    renderTip(props);
    expect(screen.getByTestId('player-preview-tip-frost').textContent).toBe(tips.frostOpenEndedScreenReader);
  });

  it('goes on Got it, the close button and Lighting settings, saying which', () => {
    const onExit = renderTip();
    fireEvent.click(screen.getByText(tips.done));
    fireEvent.click(screen.getByLabelText(tips.close));
    fireEvent.click(screen.getByText(tips.settings));
    expect(onExit.mock.calls).toEqual([['got_it'], ['close'], ['settings']]);
  });

  it('gives both buttons a full touch target', () => {
    renderTip();
    expect(screen.getByTestId('player-preview-tip-done').dataset.minHeight).toBe('44');
    expect(screen.getByTestId('player-preview-tip-settings').dataset.minHeight).toBe('44');
  });

  it('goes once a drive starts: the frost has been learned', () => {
    const onExit = renderTip();
    act(() => drive.set({ startedAt: Date.now() + 1, startedBy: 'swipe', windowMs: null }));
    expect(onExit).toHaveBeenCalledWith('drive');
  });

  it("stays through Put on board's own keep-lighting window, which it describes", () => {
    const onExit = renderTip();
    act(() => drive.set({ startedAt: Date.now() + 1, startedBy: 'tap', windowMs: 45_000 }));
    expect(onExit).not.toHaveBeenCalled();
  });

  // A swipe or Light every climb during the window clears it: the same drive
  // (same start, still 'tap') now has no end, which is the frost.
  it('goes when a swipe turns a window it saw start open-ended', () => {
    const onExit = renderTip();
    const startedAt = Date.now() + 1;
    act(() => drive.set({ startedAt, startedBy: 'tap', windowMs: 45_000 }));
    expect(onExit).not.toHaveBeenCalled();
    act(() => drive.set({ startedAt, startedBy: 'tap', windowMs: null }));
    expect(onExit).toHaveBeenCalledExactlyOnceWith('drive');
  });

  // The window was already running when the card showed (it started before
  // shownAt): only the card's own record of that window says the drive that
  // now has no end is the same one, turned open-ended by the climber.
  it('goes when a swipe turns a window already running when it showed open-ended', () => {
    const startedAt = Date.now() - 5_000;
    drive.current = { startedAt, startedBy: 'tap', windowMs: 45_000 };
    const onExit = renderTip();
    expect(onExit).not.toHaveBeenCalled();
    act(() => drive.set({ startedAt, startedBy: 'tap', windowMs: null }));
    expect(onExit).toHaveBeenCalledExactlyOnceWith('drive');
  });

  it('goes when Put on board keeps lighting until stopped', () => {
    const onExit = renderTip({ keepLighting: UNTIL_STOPPED });
    act(() => drive.set({ startedAt: Date.now() + 1, startedBy: 'tap', windowMs: null }));
    expect(onExit).toHaveBeenCalledWith('drive');
  });

  it('ignores a drive that was already on when it showed', () => {
    drive.current = { startedAt: Date.now() - 60_000, startedBy: 'swipe', windowMs: null };
    const onExit = renderTip();
    expect(onExit).not.toHaveBeenCalled();
  });
});

describe('buildDrivingSampleModel', () => {
  it('is the driving look with no face when the profile is not known', () => {
    const model = buildDrivingSampleModel(null);
    expect(model).toMatchObject({ state: 'lit', holder: 'self', driving: true, drivePhase: 'live', holderFace: null });
    expect(wallControlUsesFrost(model)).toBe(true);
  });
});
