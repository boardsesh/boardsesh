// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

type ViewProps = {
  children?: ReactNode;
  testID?: string;
  style?: unknown;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityValue?: { now?: number };
  onStartShouldSetResponder?: () => boolean;
  onLayout?: () => void;
};

const responder = vi.hoisted(() => ({ claims: [] as boolean[] }));
const motion = vi.hoisted(() => ({ reduce: false, loopStarts: 0 }));

vi.mock('react-native', () => {
  const View = ({
    children,
    testID,
    style,
    accessibilityLabel,
    accessibilityHint,
    accessibilityValue,
    onStartShouldSetResponder,
    onLayout,
  }: ViewProps) => {
    if (onStartShouldSetResponder) responder.claims.push(onStartShouldSetResponder());
    // Stands in for the native layout pass.
    onLayout?.();
    return createElement(
      'div',
      {
        'data-testid': testID,
        'data-style': JSON.stringify(style),
        'aria-label': accessibilityLabel,
        'data-hint': accessibilityHint,
        'aria-valuenow': accessibilityValue?.now,
      },
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
  Text: ({ children, variant }: { children?: ReactNode; variant?: string }) =>
    createElement('p', { 'data-variant': variant }, children),
}));
const gate = vi.hoisted(() => ({
  showPlaceholder: false,
  progress: undefined as number | undefined,
  stage: 'checking' as 'checking' | 'installing',
  firstLaunch: false,
  painted: vi.fn(),
}));
vi.mock('../use-launch-update-gate', () => ({
  useLaunchUpdateGate: () => ({ resolved: false, showPlaceholder: gate.showPlaceholder, placeholderPainted: false }),
  useLaunchUpdateProgress: () => gate.progress,
  useLaunchUpdateStage: () => gate.stage,
  useLaunchUpdateFirstLaunch: () => gate.firstLaunch,
}));
vi.mock('../../../lib/launch-update-gate-store', () => ({
  notifyLaunchUpdatePlaceholderPainted: gate.painted,
}));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => motion.reduce }));
vi.mock('../../../theme/colors', () => ({ brandColors: { primary: '#8C4A52' } }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 4: 16 } }));

import { LaunchUpdateGatePlaceholder, LaunchUpdatePlaceholder } from '../LaunchUpdatePlaceholder';

const CHECKING = { visible: true, progress: undefined, stage: 'checking', firstLaunch: false } as const;

beforeEach(() => {
  motion.reduce = false;
  motion.loopStarts = 0;
  gate.stage = 'checking';
  gate.firstLaunch = false;
  gate.painted.mockReset();
});

describe('LaunchUpdatePlaceholder', () => {
  it('sweeps the indeterminate bar when motion is allowed', () => {
    render(createElement(LaunchUpdatePlaceholder, CHECKING));

    expect(screen.getByTestId('indeterminate')).toBeTruthy();
    expect(motion.loopStarts).toBe(1);
  });

  it('rests the segment mid-track, with no loop, under Reduce Motion', () => {
    motion.reduce = true;
    render(createElement(LaunchUpdatePlaceholder, CHECKING));

    expect(screen.queryByTestId('indeterminate')).toBeNull();
    expect(screen.getByTestId('launch-update-resting-segment')).toBeTruthy();
    expect(motion.loopStarts).toBe(0);
  });

  it('renders nothing while the splash still covers the wait', () => {
    const { container } = render(createElement(LaunchUpdatePlaceholder, { ...CHECKING, visible: false }));

    expect(container.firstChild).toBeNull();
  });

  it('shows the mark at the splash size, the checking copy, and an indeterminate bar before progress exists', () => {
    render(createElement(LaunchUpdatePlaceholder, CHECKING));

    expect(screen.getByText('logo').getAttribute('data-size')).toBe('200');
    const message = screen.getByText('mobile.launchUpdate.checking');
    expect(message.getAttribute('data-variant')).toBe('headline');
    expect(screen.getByTestId('launch-update-placeholder').getAttribute('aria-label')).toBe(
      'mobile.launchUpdate.checking',
    );
    expect(screen.getByTestId('indeterminate')).toBeTruthy();
  });

  it('says it is installing once a download is under way', () => {
    render(createElement(LaunchUpdatePlaceholder, { ...CHECKING, stage: 'installing' }));

    expect(screen.getByText('mobile.launchUpdate.installing')).toBeTruthy();
    expect(screen.queryByText('mobile.launchUpdate.checking')).toBeNull();
    expect(screen.getByTestId('launch-update-placeholder').getAttribute('aria-label')).toBe(
      'mobile.launchUpdate.installing',
    );
  });

  it('adds the one-time line on a fresh install, for sighted and VoiceOver users alike', () => {
    render(createElement(LaunchUpdatePlaceholder, { ...CHECKING, stage: 'installing', firstLaunch: true }));

    const hint = screen.getByText('mobile.launchUpdate.firstLaunchHint');
    expect(hint.getAttribute('data-variant')).toBe('footnote');
    expect(screen.getByTestId('launch-update-placeholder').getAttribute('data-hint')).toBe(
      'mobile.launchUpdate.firstLaunchHint',
    );
  });

  it('leaves the one-time line off every other launch', () => {
    render(createElement(LaunchUpdatePlaceholder, { ...CHECKING, stage: 'installing' }));

    expect(screen.queryByText('mobile.launchUpdate.firstLaunchHint')).toBeNull();
    expect(screen.getByTestId('launch-update-placeholder').getAttribute('data-hint')).toBeNull();
  });

  it('fills the bar from the download progress', () => {
    render(createElement(LaunchUpdatePlaceholder, { ...CHECKING, progress: 0.42 }));

    expect(screen.queryByTestId('indeterminate')).toBeNull();
    expect(screen.getByTestId('launch-update-placeholder').getAttribute('aria-valuenow')).toBe('42');
  });

  it('stays indeterminate while the download has reported no progress yet', () => {
    render(createElement(LaunchUpdatePlaceholder, { ...CHECKING, progress: 0 }));

    expect(screen.getByTestId('indeterminate')).toBeTruthy();
  });

  it('covers the window in the splash black and claims every touch', () => {
    responder.claims = [];
    render(createElement(LaunchUpdatePlaceholder, CHECKING));

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

  it('shows the gate copy and tells the gate once it has laid out', () => {
    gate.showPlaceholder = true;
    gate.stage = 'installing';
    gate.firstLaunch = true;
    render(createElement(LaunchUpdateGatePlaceholder));

    expect(screen.getByText('mobile.launchUpdate.installing')).toBeTruthy();
    expect(screen.getByText('mobile.launchUpdate.firstLaunchHint')).toBeTruthy();
    expect(gate.painted).toHaveBeenCalled();
  });

  it('does not tell the gate it painted while it renders nothing', () => {
    gate.showPlaceholder = false;
    render(createElement(LaunchUpdateGatePlaceholder));

    expect(gate.painted).not.toHaveBeenCalled();
  });
});
