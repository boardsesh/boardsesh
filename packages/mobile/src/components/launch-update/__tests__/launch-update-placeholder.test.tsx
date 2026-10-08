// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

type ViewProps = {
  children?: ReactNode;
  testID?: string;
  style?: unknown;
  accessibilityValue?: { now?: number };
  onStartShouldSetResponder?: () => boolean;
};

const responder = vi.hoisted(() => ({ claims: [] as boolean[] }));
const motion = vi.hoisted(() => ({ reduce: false, loopStarts: 0 }));

vi.mock('react-native', () => {
  const View = ({ children, testID, style, accessibilityValue, onStartShouldSetResponder }: ViewProps) => {
    if (onStartShouldSetResponder) responder.claims.push(onStartShouldSetResponder());
    return createElement(
      'div',
      { 'data-testid': testID, 'data-style': JSON.stringify(style), 'aria-valuenow': accessibilityValue?.now },
      children,
    );
  };
  return {
    View,
    StyleSheet: { create: (styles: unknown) => styles },
    Easing: { inOut: (easing: unknown) => easing, ease: 'ease' },
    Animated: {
      View: ({ children }: ViewProps) => createElement('div', { 'data-testid': 'indeterminate' }, children),
      Value: class {
        interpolate() {
          return 0;
        }
      },
      timing: () => ({}),
      loop: () => ({
        start: () => {
          motion.loopStarts += 1;
        },
        stop: () => {},
      }),
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../BoardseshLogo', () => ({
  BoardseshLogo: ({ size }: { size?: number }) => createElement('span', { 'data-size': size }, 'logo'),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('p', null, children),
}));
const gate = vi.hoisted(() => ({ showPlaceholder: false, progress: undefined as number | undefined }));
vi.mock('../use-launch-update-gate', () => ({
  useLaunchUpdateGate: () => ({ resolved: false, showPlaceholder: gate.showPlaceholder }),
  useLaunchUpdateProgress: () => gate.progress,
}));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => motion.reduce }));
vi.mock('../../../theme/colors', () => ({ brandColors: { primary: '#8C4A52' } }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 4: 16 } }));

import { LaunchUpdateGatePlaceholder, LaunchUpdatePlaceholder } from '../LaunchUpdatePlaceholder';

beforeEach(() => {
  motion.reduce = false;
  motion.loopStarts = 0;
});

describe('LaunchUpdatePlaceholder', () => {
  it('sweeps the indeterminate bar when motion is allowed', () => {
    render(createElement(LaunchUpdatePlaceholder, { visible: true, progress: undefined }));

    expect(screen.getByTestId('indeterminate')).toBeTruthy();
    expect(motion.loopStarts).toBe(1);
  });

  it('rests the segment mid-track, with no loop, under Reduce Motion', () => {
    motion.reduce = true;
    render(createElement(LaunchUpdatePlaceholder, { visible: true, progress: undefined }));

    expect(screen.queryByTestId('indeterminate')).toBeNull();
    expect(screen.getByTestId('launch-update-resting-segment')).toBeTruthy();
    expect(motion.loopStarts).toBe(0);
  });

  it('renders nothing while the splash still covers the wait', () => {
    const { container } = render(createElement(LaunchUpdatePlaceholder, { visible: false, progress: undefined }));

    expect(container.firstChild).toBeNull();
  });

  it('shows the mark at the splash size, the copy, and an indeterminate bar before progress exists', () => {
    render(createElement(LaunchUpdatePlaceholder, { visible: true, progress: undefined }));

    expect(screen.getByText('logo').getAttribute('data-size')).toBe('200');
    expect(screen.getByText('mobile.launchUpdate.message')).toBeTruthy();
    expect(screen.getByTestId('indeterminate')).toBeTruthy();
  });

  it('fills the bar from the download progress', () => {
    render(createElement(LaunchUpdatePlaceholder, { visible: true, progress: 0.42 }));

    expect(screen.queryByTestId('indeterminate')).toBeNull();
    expect(screen.getByTestId('launch-update-placeholder').getAttribute('aria-valuenow')).toBe('42');
  });

  it('stays indeterminate while the download has reported no progress yet', () => {
    render(createElement(LaunchUpdatePlaceholder, { visible: true, progress: 0 }));

    expect(screen.getByTestId('indeterminate')).toBeTruthy();
  });

  it('covers the window in the splash black and claims every touch', () => {
    responder.claims = [];
    render(createElement(LaunchUpdatePlaceholder, { visible: true, progress: undefined }));

    const style = JSON.parse(screen.getByTestId('launch-update-placeholder').getAttribute('data-style') ?? '{}');
    expect(style).toMatchObject({
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: '#000000',
    });
    expect(responder.claims).toEqual([true]);
  });
});

describe('LaunchUpdateGatePlaceholder', () => {
  it('renders nothing until the gate asks for the placeholder', () => {
    gate.showPlaceholder = false;
    const { container } = render(createElement(LaunchUpdateGatePlaceholder));

    expect(container.firstChild).toBeNull();
  });

  it('shows the gate progress once the placeholder is up', () => {
    gate.showPlaceholder = true;
    gate.progress = 0.75;
    render(createElement(LaunchUpdateGatePlaceholder));

    expect(screen.getByTestId('launch-update-placeholder').getAttribute('aria-valuenow')).toBe('75');
  });
});
