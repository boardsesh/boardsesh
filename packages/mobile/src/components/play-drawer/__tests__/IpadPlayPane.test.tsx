// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// resolveWallSurface (real, pure) decides strip vs column from these. SIDEBAR_WIDTH
// (real, 96) is used too, so the widths below mirror real iPad geometry:
// 834 (11" portrait) → strip; 1366 (13" landscape) → column.
const cfg = vi.hoisted(() => ({
  width: 834,
  widthClass: 'regular' as 'compact' | 'regular',
  presenceEnabled: true,
  presenceBoardId: 1 as number | null,
  paneProps: { boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 1, setIds: '1', angle: 40 } } as Record<
    string,
    unknown
  > | null,
}));

const captured = vi.hoisted(() => ({ playDrawerProps: null as Record<string, unknown> | null }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: cfg.width, height: 1024 }),
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  PlatformColor: (name: string) => name,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('../PlayDrawer', () => ({
  PlayDrawer: (props: Record<string, unknown>) => {
    captured.playDrawerProps = props;
    return createElement('div', { 'data-play-drawer': 'true' });
  },
}));

vi.mock('../PanePlaceholder', () => ({
  PanePlaceholder: () => createElement('div', { 'data-pane-placeholder': 'true' }),
}));

vi.mock('../../board-presence/WallStrip', () => ({
  WallStrip: () => createElement('div', { 'data-wall-strip': 'true' }),
}));

vi.mock('../../Icon', () => ({ Icon: () => createElement('span') }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ playDrawerPaneProps: cfg.paneProps }),
}));

vi.mock('../../../providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => ({ enabled: cfg.presenceEnabled, boardId: cfg.presenceBoardId }),
}));

vi.mock('../../../hooks/use-device-layout', () => ({
  useDeviceLayout: () => ({ widthClass: cfg.widthClass, expanded: false }),
}));

import { IpadPlayPane } from '../IpadPlayPane';

describe('IpadPlayPane wall surface', () => {
  beforeEach(() => {
    cfg.width = 834;
    cfg.widthClass = 'regular';
    cfg.presenceEnabled = true;
    cfg.presenceBoardId = 1;
    cfg.paneProps = { boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 1, setIds: '1', angle: 40 } };
    captured.playDrawerProps = null;
  });

  it('docks the wall strip atop the pane in portrait and tells PlayDrawer to skip the top inset', () => {
    // 834pt regular → no room for a column → strip; a board is bound.
    const { container } = render(<IpadPlayPane />);
    expect(container.querySelector('[data-wall-strip="true"]')).not.toBeNull();
    expect(captured.playDrawerProps?.paneTopInset).toBe(false);
  });

  it('shows no strip in landscape (the column carries the wall) and keeps the pane top inset', () => {
    cfg.width = 1366; // → column surface; the strip is not docked here
    const { container } = render(<IpadPlayPane />);
    expect(container.querySelector('[data-wall-strip="true"]')).toBeNull();
    expect(captured.playDrawerProps?.paneTopInset).toBe(true);
  });

  it('shows no strip when board presence is not bound, keeping the pane top inset', () => {
    cfg.presenceBoardId = null;
    const { container } = render(<IpadPlayPane />);
    expect(container.querySelector('[data-wall-strip="true"]')).toBeNull();
    expect(captured.playDrawerProps?.paneTopInset).toBe(true);
  });

  it('renders the shared placeholder (not the drawer) when no board is resolved', () => {
    // No pane props → nothing selected: the pane shows the shared PanePlaceholder
    // instead of the drawer, and there's no wall strip to dock.
    cfg.paneProps = null;
    const { container } = render(<IpadPlayPane />);
    expect(container.querySelector('[data-pane-placeholder="true"]')).not.toBeNull();
    expect(container.querySelector('[data-play-drawer="true"]')).toBeNull();
    expect(container.querySelector('[data-wall-strip="true"]')).toBeNull();
  });
});
