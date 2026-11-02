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
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#888' } }),
}));
vi.mock('../../../theme/colors', () => ({ withAlpha: (color: string) => color }));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2 }));
vi.mock('../../Text', () => ({
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('span', { 'data-testid': testID }, children),
}));

import { enterDriveMode, markDriveLive, resetDriveModeForTests } from '../drive-mode-store';
import { BoardSheetStatusLine } from '../BoardSheetStatusLine';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  resetDriveModeForTests();
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

  it("counts the window's seconds down, once a second", () => {
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
      'playView.wallControl.eachPickLights · playView.wallControl.secondsLeft {"count":45}',
    );
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(lineOf(container)).toBe(
      'playView.wallControl.eachPickLights · playView.wallControl.secondsLeft {"count":44}',
    );
  });

  it('says nothing for a window with no clock yet', () => {
    expect(lineOf(render(createElement(BoardSheetStatusLine, { status: 'window' })).container)).toBeNull();
  });
});
