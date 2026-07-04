// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const cfg = vi.hoisted(() => ({
  enabled: true,
  boardId: 1 as number | null,
  boardPanelProps: {
    boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 1, setIds: '1', angle: 40 },
    boardLabel: 'Kilter',
  } as Record<string, unknown> | null,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

vi.mock('../wall-kiosk/WallKioskScreen', () => ({
  WallKioskScreen: (props: { boardConfig?: { boardName?: string } }) =>
    createElement('div', { 'data-kiosk': 'true', 'data-board': props.boardConfig?.boardName ?? '' }),
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
  });

  it('shows the connect empty state when no board is bound', () => {
    cfg.boardId = null;
    const { container } = render(<WallScreen />);
    expect(container.querySelector('[data-empty="true"]')).not.toBeNull();
    expect(container.querySelector('[data-kiosk="true"]')).toBeNull();
  });

  it('shows the empty state when board presence is disabled', () => {
    cfg.enabled = false;
    const { container } = render(<WallScreen />);
    expect(container.querySelector('[data-empty="true"]')).not.toBeNull();
    expect(container.querySelector('[data-kiosk="true"]')).toBeNull();
  });

  it('renders a neutral blank (not the connect CTA) while a bound board config is still resolving', () => {
    // Bound over Bluetooth (enabled + boardId) but boardPanelProps not yet resolved:
    // the connect CTA would be wrong for someone who just connected.
    cfg.boardPanelProps = null;
    const { container } = render(<WallScreen />);
    expect(container.querySelector('[data-empty="true"]')).toBeNull();
    expect(container.querySelector('[data-kiosk="true"]')).toBeNull();
  });

  it('renders the kiosk with the resolved board config once the wall is live', () => {
    const { container } = render(<WallScreen />);
    expect(container.querySelector('[data-empty="true"]')).toBeNull();
    const kiosk = container.querySelector('[data-kiosk="true"]');
    expect(kiosk).not.toBeNull();
    expect(kiosk?.getAttribute('data-board')).toBe('kilter');
  });
});
