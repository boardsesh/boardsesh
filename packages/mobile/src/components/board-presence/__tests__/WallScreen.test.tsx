// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';

const cfg = vi.hoisted(() => ({
  enabled: true,
  boardId: 1 as number | null,
  boardPanelProps: {
    boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 1, setIds: '1', angle: 40 },
    boardLabel: 'Kilter',
  } as Record<string, unknown> | null,
  // The width the root View reports via onLayout — WallScreen picks two-pane at >=700.
  layoutWidth: 400,
}));

vi.mock('react-native', () => ({
  // Fire onLayout from an effect so the width-driven branch is exercised (jsdom has
  // no real layout pass). Only WallScreen's root View passes onLayout.
  View: ({
    children,
    onLayout,
  }: {
    children?: ReactNode;
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  }) => {
    useEffect(() => {
      if (onLayout) onLayout({ nativeEvent: { layout: { width: cfg.layoutWidth, height: 800 } } });
    }, [onLayout]);
    return createElement('div', null, children);
  },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

vi.mock('../NowOnTheWallPanel', () => ({
  NowOnTheWallPanel: (props: { showHero?: boolean }) =>
    createElement('div', { 'data-panel': 'true', 'data-show-hero': String(props.showHero ?? true) }),
}));
vi.mock('../WallFocalClimb', () => ({
  WallFocalClimb: () => createElement('div', { 'data-focal': 'true' }),
}));
vi.mock('../WallEmptyState', () => ({
  WallEmptyState: () => createElement('div', { 'data-empty': 'true' }),
}));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ boardPanelProps: cfg.boardPanelProps }),
}));
vi.mock('../../../providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => ({ enabled: cfg.enabled, boardId: cfg.boardId }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#000', separator: '#333' } }),
}));

import { WallScreen } from '../WallScreen';

describe('WallScreen', () => {
  beforeEach(() => {
    cfg.enabled = true;
    cfg.boardId = 1;
    cfg.boardPanelProps = {
      boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 1, setIds: '1', angle: 40 },
      boardLabel: 'Kilter',
    };
    cfg.layoutWidth = 400;
  });

  it('shows the connect empty state when no board is bound', () => {
    cfg.boardId = null;
    const { container } = render(<WallScreen />);
    expect(container.querySelector('[data-empty="true"]')).not.toBeNull();
    expect(container.querySelector('[data-panel="true"]')).toBeNull();
    expect(container.querySelector('[data-focal="true"]')).toBeNull();
  });

  it('shows the empty state when board presence is disabled', () => {
    cfg.enabled = false;
    const { container } = render(<WallScreen />);
    expect(container.querySelector('[data-empty="true"]')).not.toBeNull();
  });

  it('renders a single-column panel (hero shown, no focal) in a narrow pane', () => {
    cfg.layoutWidth = 400;
    const { container } = render(<WallScreen />);
    expect(container.querySelector('[data-empty="true"]')).toBeNull();
    expect(container.querySelector('[data-focal="true"]')).toBeNull();
    const panel = container.querySelector('[data-panel="true"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('data-show-hero')).toBe('true');
  });

  it('splits into a focal pane + hero-less list at/above the regular breakpoint', () => {
    cfg.layoutWidth = 900;
    const { container } = render(<WallScreen />);
    expect(container.querySelector('[data-focal="true"]')).not.toBeNull();
    const panel = container.querySelector('[data-panel="true"]');
    expect(panel).not.toBeNull();
    // The focal pane owns the lit climb, so the trailing list drops its hero.
    expect(panel?.getAttribute('data-show-hero')).toBe('false');
  });
});
