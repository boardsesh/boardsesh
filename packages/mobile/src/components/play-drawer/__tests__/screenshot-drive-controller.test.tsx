// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreenshotDriveController } from '../ScreenshotDriveController';
import {
  clearScreenshotDriveRequest,
  getScreenshotDriveRequest,
  requestScreenshotDrive,
} from '../../../lib/screenshot-driving';

vi.mock('react-native', () => ({
  View: ({ testID, children }: { testID?: string; children?: ReactNode }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
}));

const offModel = {
  state: 'connect' as const,
  driving: false,
  drivePhase: 'off' as const,
  pending: false,
  writing: false,
  swipeAction: 'drive' as const,
};
const liveModel = {
  ...offModel,
  state: 'lit' as const,
  driving: true,
  drivePhase: 'live' as const,
  swipeAction: null,
};
function props() {
  return {
    boardUuid: 'board-a',
    climbUuid: 'climb-a',
    eligible: true,
    sessionId: null,
    connected: false,
    displayedLit: false,
    mirrored: false,
    model: offModel,
    start: vi.fn(() => 'started' as const),
  };
}

beforeEach(() => {
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_DRIVING', '1');
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_FAKE_BLE', '1');
  clearScreenshotDriveRequest();
});
afterEach(() => {
  cleanup();
  clearScreenshotDriveRequest();
  vi.unstubAllEnvs();
});

describe('explicit screenshot driving', () => {
  it('leaves ordinary captures alone and requires both screenshot gates', () => {
    const options = props();
    const view = render(<ScreenshotDriveController {...options} />);
    expect(options.start).not.toHaveBeenCalled();
    for (const flag of [
      'EXPO_PUBLIC_SCREENSHOT_MODE',
      'EXPO_PUBLIC_SCREENSHOT_DRIVING',
      'EXPO_PUBLIC_SCREENSHOT_FAKE_BLE',
    ]) {
      vi.stubEnv(flag, '0');
      act(() => requestScreenshotDrive('board-a', 'climb-a'));
      expect(getScreenshotDriveRequest()).toBeNull();
      vi.stubEnv(flag, '1');
    }
    expect(view.queryByTestId('store-driving-board-a-climb-a')).toBeNull();
  });

  it('starts once when the exact hero becomes eligible, even after rerenders', () => {
    const options = props();
    options.start.mockReturnValue('started');
    act(() => requestScreenshotDrive('board-a', 'climb-a'));
    const view = render(<ScreenshotDriveController {...options} model={{ ...offModel, swipeAction: null }} />);
    expect(options.start).not.toHaveBeenCalled();
    view.rerender(<ScreenshotDriveController {...options} />);
    expect(options.start).toHaveBeenCalledTimes(1);
    view.rerender(<ScreenshotDriveController {...options} start={() => options.start()} />);
    expect(options.start).toHaveBeenCalledTimes(1);
    act(() => requestScreenshotDrive('board-a', 'climb-a'));
    expect(options.start).toHaveBeenCalledTimes(2);
  });

  it('does not retry a refused action on subsequent renders', () => {
    const options = { ...props(), start: vi.fn(() => 'unavailable' as const) };
    act(() => requestScreenshotDrive('board-a', 'climb-a'));
    const view = render(<ScreenshotDriveController {...options} />);
    view.rerender(<ScreenshotDriveController {...options} model={{ ...offModel }} />);
    expect(options.start).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('[data-testid]')).toBeNull();
  });

  it.each([{ boardUuid: 'board-b' }, { climbUuid: 'climb-b' }, { eligible: false }, { sessionId: 'crew' }])(
    'does not act on a mismatched, LED-less, or shared scene: %j',
    (override) => {
      const options = props();
      act(() => requestScreenshotDrive('board-a', 'climb-a'));
      const view = render(<ScreenshotDriveController {...options} {...override} />);
      expect(options.start).not.toHaveBeenCalled();
      view.rerender(<ScreenshotDriveController {...options} {...override} connected displayedLit model={liveModel} />);
      expect(view.container.querySelector('[data-testid]')).toBeNull();
    },
  );

  it.each(['started', 'unavailable'] as const)('does not repeat a %s attempt after a player remount', (outcome) => {
    const options = { ...props(), start: vi.fn(() => outcome) };
    act(() => requestScreenshotDrive('board-a', 'climb-a'));
    const first = render(<ScreenshotDriveController {...options} />);
    expect(options.start).toHaveBeenCalledTimes(1);
    first.unmount();
    render(<ScreenshotDriveController {...options} />);
    expect(options.start).toHaveBeenCalledTimes(1);
  });

  it('claims one attempt across overlapping route and Duo pane controllers', () => {
    const options = props();
    act(() => requestScreenshotDrive('board-a', 'climb-a'));
    render(
      <>
        <ScreenshotDriveController {...options} />
        <ScreenshotDriveController {...options} />
      </>,
    );
    expect(options.start).toHaveBeenCalledTimes(1);
  });

  it('withholds readiness until a confirmed live drive lights the exact displayed climb', () => {
    const options = props();
    act(() => requestScreenshotDrive('board-a', 'climb-a'));
    const view = render(<ScreenshotDriveController {...options} />);
    expect(view.container.querySelector('[data-testid]')).toBeNull();
    view.rerender(
      <ScreenshotDriveController {...options} connected displayedLit model={{ ...liveModel, drivePhase: 'arming' }} />,
    );
    expect(view.container.querySelector('[data-testid]')).toBeNull();
    view.rerender(
      <ScreenshotDriveController {...options} connected displayedLit model={{ ...liveModel, writing: true }} />,
    );
    expect(view.container.querySelector('[data-testid]')).toBeNull();
    view.rerender(<ScreenshotDriveController {...options} connected displayedLit model={liveModel} />);
    expect(view.getByTestId('store-driving-board-a-climb-a')).toBeTruthy();
    view.rerender(<ScreenshotDriveController {...options} connected displayedLit mirrored model={liveModel} />);
    expect(view.getByTestId('store-driving-board-a-climb-a-mirrored')).toBeTruthy();
    act(() => requestScreenshotDrive('board-b', 'climb-b'));
    expect(view.container.querySelector('[data-testid]')).toBeNull();
    expect(options.start).toHaveBeenCalledTimes(1);
  });

  it('does not restart an already-driving Duo pane after it is stopped', () => {
    const options = props();
    act(() => requestScreenshotDrive('board-a', 'climb-a'));
    const view = render(<ScreenshotDriveController {...options} connected displayedLit model={liveModel} />);
    view.rerender(<ScreenshotDriveController {...options} />);
    expect(options.start).not.toHaveBeenCalled();
  });
});
