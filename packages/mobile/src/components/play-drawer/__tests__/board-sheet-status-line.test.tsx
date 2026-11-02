// @vitest-environment jsdom
// The player's board sheet's status line (spec B3): the wall button's words in
// full, the window's time counting down once a second.
import { act, cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  cancelAnimation: vi.fn(),
  Easing: { linear: (value: number) => value },
  useAnimatedStyle: (build: () => unknown) => build(),
  useSharedValue: (value: number) => ({ value }),
  withSequence: (...steps: number[]) => steps[steps.length - 1],
  withTiming: (value: number) => value,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));
const theme = vi.hoisted(() => ({ colorScheme: 'light' as 'light' | 'dark' }));
vi.mock('../../../providers/theme-provider', () => ({
  // iOS's translucent secondaryLabel, the colour the line must not take.
  useTheme: () => ({ colorScheme: theme.colorScheme, systemColors: { secondaryLabel: 'rgba(60,60,67,0.6)' } }),
}));
vi.mock('../../../theme/colors', async () => {
  const { materialSurfaces } = await import('@boardsesh/velvet-tokens');
  return { withAlpha: (color: string) => color, materialSurfaces };
});
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2 }));
vi.mock('../../Text', () => ({
  Text: ({
    children,
    testID,
    color,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    testID?: string;
    color?: string;
    accessibilityLabel?: string;
  }) =>
    createElement('span', { 'data-testid': testID, 'data-color': color, 'aria-label': accessibilityLabel }, children),
}));

import { materialSurfaces } from '@boardsesh/velvet-tokens';
import { enterDriveMode, markDriveLive, resetDriveModeForTests } from '../drive-mode-store';
import { BoardSheetStatusLine } from '../BoardSheetStatusLine';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  resetDriveModeForTests();
  theme.colorScheme = 'light';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetDriveModeForTests();
});

const lineOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="ble-control-status"]')?.textContent ?? null;

describe('BoardSheetStatusLine', () => {
  it.each([
    ['preview', 'playView.wallControl.sheetStatusPreview'],
    ['on_wall', 'playView.wallControl.onWall'],
    ['driving', 'playView.wallControl.sheetStatusDriving'],
  ] as const)('says %s in full', (status, line) => {
    expect(lineOf(render(createElement(BoardSheetStatusLine, { status })).container)).toBe(line);
  });

  it("counts the window down once a second, in the button's m:ss", () => {
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: null,
        boardId: null,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
      markDriveLive();
    });
    const { container } = render(createElement(BoardSheetStatusLine, { status: 'window' }));
    expect(lineOf(container)).toBe(
      'playView.wallControl.youAreDriving · playView.wallControl.stopsInClock {"clock":"0:45"}',
    );
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(lineOf(container)).toBe(
      'playView.wallControl.youAreDriving · playView.wallControl.stopsInClock {"clock":"0:44"}',
    );
  });

  // 2 and 5 minute drives: minutes and seconds, as the button's clock reads, never "287 seconds".
  it('reads a 5 minute drive as 4:47, while the spoken value keeps its 10 s step', () => {
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: null,
        boardId: null,
        windowMs: 300_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
      markDriveLive();
    });
    const { container } = render(createElement(BoardSheetStatusLine, { status: 'window' }));
    act(() => {
      vi.advanceTimersByTime(13_000);
    });
    expect(lineOf(container)).toBe(
      'playView.wallControl.youAreDriving · playView.wallControl.stopsInClock {"clock":"4:47"}',
    );
    expect(container.querySelector('[data-testid="ble-control-status"]')?.getAttribute('aria-label')).toBe(
      'playView.wallControl.youAreDriving, playView.wallControl.stopsInSeconds {"count":280}',
    );
  });

  // The full-size fallback for the capped wall button (spec B3): Velvet's
  // opaque secondary label (wall-control-button-contrast), never iOS's 3.44:1.
  it.each(['light', 'dark'] as const)('draws in the opaque secondary label in %s', (scheme) => {
    theme.colorScheme = scheme;
    const { container } = render(createElement(BoardSheetStatusLine, { status: 'preview' }));
    const line = container.querySelector('[data-testid="ble-control-status"]');
    expect(line?.getAttribute('data-color')).toBe(materialSurfaces[scheme].secondaryLabel);
  });

  it('reads the "·" as a pause, not "middle dot"', () => {
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: null,
        boardId: null,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
      markDriveLive();
    });
    const { container } = render(createElement(BoardSheetStatusLine, { status: 'window' }));
    expect(container.querySelector('[data-testid="ble-control-status"]')?.getAttribute('aria-label')).toBe(
      'playView.wallControl.youAreDriving, playView.wallControl.stopsInSeconds {"count":40}',
    );
  });

  // Focus lands on this line when the sheet opens, and TalkBack re-reads a
  // focused node's changed label: the spoken count keeps the button's 10 s step
  // while the digits on screen tick each second (spec B2.2).
  it('keeps its spoken label still across a 1 s tick, on the 10 s step, then says under 10 seconds', () => {
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: null,
        boardId: null,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
      markDriveLive();
    });
    const { container } = render(createElement(BoardSheetStatusLine, { status: 'window' }));
    const label = () => container.querySelector('[data-testid="ble-control-status"]')?.getAttribute('aria-label');
    const before = label();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(lineOf(container)).toBe(
      'playView.wallControl.youAreDriving · playView.wallControl.stopsInClock {"clock":"0:44"}',
    );
    expect(label()).toBe(before);
    act(() => {
      vi.advanceTimersByTime(36_000);
    });
    expect(label()).toBe('playView.wallControl.youAreDriving, playView.wallControl.stopsInUnderTen');
  });

  it('says nothing for a window with no clock yet', () => {
    expect(lineOf(render(createElement(BoardSheetStatusLine, { status: 'window' })).container)).toBeNull();
  });
});
