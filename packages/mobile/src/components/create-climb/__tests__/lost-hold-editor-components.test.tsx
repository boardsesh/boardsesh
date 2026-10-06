// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { LostHoldGhost } from '@boardsesh/create-climb-react';

/**
 * The three pieces of the create editor's lost-hold layer (#5493): the dashed
 * rings on the board, the banner over it, and the sheet a ring opens.
 */

type HostProps = {
  children?: ReactNode;
  testID?: string;
  onPress?: () => void;
  disabled?: boolean;
  pointerEvents?: string;
  accessibilityLabel?: string;
};

function host(tag: string) {
  return ({ children, testID, onPress, disabled, pointerEvents, accessibilityLabel }: HostProps) =>
    createElement(
      tag,
      {
        'data-testid': testID,
        'data-pointer-events': pointerEvents,
        'aria-label': accessibilityLabel,
        disabled,
        onClick: disabled ? undefined : onPress,
      },
      children,
    );
}

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  View: host('div'),
  Pressable: host('button'),
}));

type SvgProps = {
  children?: ReactNode;
  testID?: string;
  stroke?: string;
  strokeWidth?: number;
  strokeDasharray?: number[];
};
vi.mock('react-native-svg', () => {
  const element =
    (tag: string) =>
    ({ children, testID, stroke, strokeWidth, strokeDasharray }: SvgProps) =>
      createElement(
        tag,
        {
          'data-testid': testID,
          'data-stroke': stroke,
          'data-width': strokeWidth,
          'data-dashed': strokeDasharray ? 'yes' : 'no',
        },
        children,
      );
  return { default: element('svg'), G: element('g'), Path: element('path') };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count == null ? key : `${key}#${options.count}`),
  }),
}));
vi.mock('@expo/ui/community/bottom-sheet', () => ({ default: {} }));
vi.mock('../../Sheet', () => ({
  Sheet: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { fill: '#333', label: '#fff', secondaryLabel: '#999' } }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { md: 8, lg: 12 },
  opacity: { disabled: 0.5 },
  overlays: { scrim: 'rgba(0,0,0,0.6)', onScrim: '#fff' },
}));
vi.mock('../../../lib/hold-color-overrides', () => ({
  useHoldColorOverrides: () => ({ overrides: {} }),
  getEffectiveHoldRoleColor: (_boardName: string, role: string) => `role-${role}`,
}));
vi.mock('../../outline-editor/stroke', () => ({
  placementRingPathData: (hold: { id: number }) => `circle-${hold.id}`,
  ringToPathData: () => 'ring',
  radiusRingToBoardPx: (ring: number[]) => ring,
}));

const { LostHoldGhostLayer } = await import('../LostHoldGhostLayer');
const { LostHoldsEditorBanner } = await import('../LostHoldsEditorBanner');
const { LostHoldSheet } = await import('../LostHoldSheet');

const GHOST: LostHoldGhost = {
  id: 7,
  cx: 100,
  cy: 100,
  r: 10,
  role: 'STARTING',
  color: '#00DD00',
  placements: [{ frameIndex: 0, state: 'STARTING' }],
};

const LAYER_SIZE = { boardWidth: 1000, boardHeight: 1000, renderWidth: 500, renderHeight: 500 };

describe('LostHoldGhostLayer', () => {
  it('draws nothing when there is nothing to draw', () => {
    const { container } = render(
      <LostHoldGhostLayer boardName="spray" ghosts={[]} candidateHolds={[]} {...LAYER_SIZE} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('draws each ghost dashed, in its role colour', () => {
    render(<LostHoldGhostLayer boardName="spray" ghosts={[GHOST]} candidateHolds={[]} {...LAYER_SIZE} />);
    const paths = screen.getByTestId('lost-hold-ghost-7').querySelectorAll('path');
    expect(paths).toHaveLength(2);
    expect(paths[1].getAttribute('data-stroke')).toBe('role-STARTING');
    expect(paths[1].getAttribute('data-dashed')).toBe('yes');
  });

  it('draws candidates solid, and the successor heavier', () => {
    render(
      <LostHoldGhostLayer
        boardName="spray"
        ghosts={[GHOST]}
        candidateHolds={[
          { id: 11, cx: 120, cy: 100, r: 10, isSuccessor: true },
          { id: 12, cx: 140, cy: 100, r: 10, isSuccessor: false },
        ]}
        {...LAYER_SIZE}
      />,
    );
    const successor = screen.getByTestId('lost-hold-candidate-11').querySelectorAll('path')[1];
    const nearby = screen.getByTestId('lost-hold-candidate-12').querySelectorAll('path')[1];
    expect(successor.getAttribute('data-dashed')).toBe('no');
    expect(Number(successor.getAttribute('data-width'))).toBeGreaterThan(Number(nearby.getAttribute('data-width')));
  });
});

function renderBanner(overrides: Partial<Parameters<typeof LostHoldsEditorBanner>[0]> = {}) {
  const props = {
    status: 'ready' as const,
    count: 2,
    replacing: false,
    roleFull: false,
    onOpenFirstGhost: vi.fn(),
    onCancelReplacing: vi.fn(),
    ...overrides,
  };
  const view = render(<LostHoldsEditorBanner {...props} />);
  return { ...view, props };
}

describe('LostHoldsEditorBanner', () => {
  it('says nothing when nothing is lost', () => {
    const { container } = renderBanner({ status: 'none', count: 0 });
    expect(container.innerHTML).toBe('');
  });

  it('points at the rings and opens the first one when tapped', () => {
    const { props } = renderBanner();
    const banner = screen.getByTestId('lost-holds-editor-banner');
    expect(banner.textContent).toContain('mobile.lostHolds.editor.tapGhost#2');
    expect(banner.getAttribute('data-pointer-events')).toBe('auto');
    fireEvent.click(banner);
    expect(props.onOpenFirstGhost).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['countOnly', 'mobile.lostHolds.banner#2'],
    ['noPositions', 'mobile.lostHolds.editor.noPositions#2'],
    ['unavailable', 'mobile.lostHolds.editor.offline#2'],
  ] as const)('states the count for %s and lets touches through to the board', (status, copy) => {
    renderBanner({ status });
    const banner = screen.getByTestId('lost-holds-editor-banner');
    expect(banner.textContent).toContain(copy);
    expect(banner.getAttribute('data-pointer-events')).toBe('none');
  });

  it('during a pick, says what a tap does and offers Cancel', () => {
    const { props } = renderBanner({ replacing: true });
    const banner = screen.getByTestId('lost-holds-editor-banner');
    expect(banner.textContent).toContain('mobile.lostHolds.editor.pickNearby');
    expect(banner.getAttribute('data-pointer-events')).toBe('box-none');
    fireEvent.click(screen.getByTestId('lost-holds-editor-cancel'));
    expect(props.onCancelReplacing).toHaveBeenCalledTimes(1);
  });

  it('says the role is full when a hold put back on the wall could not go in', () => {
    renderBanner({ roleFull: true });
    expect(screen.getByTestId('lost-holds-editor-banner').textContent).toContain('mobile.lostHolds.editor.roleFull');
  });

  it('says the role is full when a pick was refused', () => {
    renderBanner({ replacing: true, roleFull: true });
    expect(screen.getByTestId('lost-holds-editor-banner').textContent).toContain('mobile.lostHolds.editor.roleFull');
  });
});

describe('LostHoldSheet', () => {
  it('names the role the hold played and offers a hold nearby', () => {
    const onUseNearby = vi.fn();
    render(
      <LostHoldSheet
        ghost={GHOST}
        candidates={[{ holdId: 11, distance: 20, isSuccessor: false }]}
        onUseNearby={onUseNearby}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('lost-hold-sheet').textContent).toContain('mobile.lostHolds.sheet.wasStart');
    expect(screen.getByTestId('lost-hold-sheet').textContent).toContain('mobile.lostHolds.sheet.useNearbyHint');
    fireEvent.click(screen.getByTestId('lost-hold-use-nearby'));
    expect(onUseNearby).toHaveBeenCalledTimes(1);
  });

  it('says the successor lights up first when there is one', () => {
    render(
      <LostHoldSheet
        ghost={GHOST}
        candidates={[{ holdId: 11, distance: 20, isSuccessor: true }]}
        onUseNearby={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('lost-hold-sheet').textContent).toContain('mobile.lostHolds.sheet.useNearbySuccessor');
  });

  it('disables the swap when the wall has no free hold', () => {
    const onUseNearby = vi.fn();
    render(<LostHoldSheet ghost={GHOST} candidates={[]} onUseNearby={onUseNearby} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('lost-hold-use-nearby'));
    expect(onUseNearby).not.toHaveBeenCalled();
    expect(screen.getByTestId('lost-hold-sheet').textContent).toContain('mobile.lostHolds.sheet.noneNearby');
  });
});
