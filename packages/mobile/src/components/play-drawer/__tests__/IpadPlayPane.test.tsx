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
  // 'panel-capable' (11" Pro / 13") keeps the strip/column; 'sheet-only' collapses it.
  wallDeviceClass: 'panel-capable' as 'panel-capable' | 'sheet-only',
  // Focused route — the strip is suppressed while the "On the Wall" tab is open.
  presenceEnabled: true,
  presenceBoardId: 1 as number | null,
  paneProps: { boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 1, setIds: '1', angle: 40 } } as Record<
    string,
    unknown
  > | null,
}));

const captured = vi.hoisted(() => ({
  playDrawerProps: null as Record<string, unknown> | null,
  placeholderProps: null as Record<string, unknown> | null,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: cfg.width, height: 1024 }),
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
}));

vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('../../../lib/boards/first-board-mode', () => ({ NO_BOARD_PICKER_HREF: '/boards' }));
vi.mock('../UnlitBoardPane', () => ({
  UnlitBoardPane: () => createElement('div', { 'data-unlit-board': 'true' }),
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
  PanePlaceholder: (props: Record<string, unknown>) => {
    captured.placeholderProps = props;
    return createElement('div', { 'data-pane-placeholder': 'true' });
  },
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
  useDeviceLayout: () => ({ widthClass: cfg.widthClass, expanded: false, wallDeviceClass: cfg.wallDeviceClass }),
}));

import { IpadPlayPane } from '../IpadPlayPane';
import { markWallDisplayMounted } from '../../../lib/wall-display-presence';

describe('IpadPlayPane wall surface', () => {
  beforeEach(() => {
    cfg.width = 834;
    cfg.widthClass = 'regular';
    cfg.wallDeviceClass = 'panel-capable';
    cfg.presenceEnabled = true;
    cfg.presenceBoardId = 1;
    cfg.paneProps = { boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 1, setIds: '1', angle: 40 } };
    captured.playDrawerProps = null;
    captured.placeholderProps = null;
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

  it('shows no strip on a small (sheet-only) iPad — the wall collapses to the sheet', () => {
    // Same 834pt portrait that would dock a strip, but the device is below the 11"
    // Pro floor, so the wall is sheet-only (matches the shell gate).
    cfg.wallDeviceClass = 'sheet-only';
    const { container } = render(<IpadPlayPane />);
    expect(container.querySelector('[data-wall-strip="true"]')).toBeNull();
    expect(captured.playDrawerProps?.paneTopInset).toBe(true);
  });

  it('shows no strip while the Wall display covers the shell, even with a page pushed over it', () => {
    // The display already shows the wall feed, so the ambient strip steps aside.
    // The display stays marked while a page (the player, say) is pushed over it,
    // so the strip must not come back behind it.
    const release = markWallDisplayMounted();
    try {
      const { container } = render(<IpadPlayPane />);
      expect(container.querySelector('[data-wall-strip="true"]')).toBeNull();
      expect(captured.playDrawerProps?.paneTopInset).toBe(true);
    } finally {
      release();
    }
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

  it('keeps the iPad empty states: no unlit board, no board-picker action', () => {
    render(<IpadPlayPane />);
    expect(captured.playDrawerProps?.paneEmptyState).toBeUndefined();
    cfg.paneProps = null;
    render(<IpadPlayPane />);
    expect(captured.placeholderProps?.actionTitle).toBeUndefined();
  });
});

describe('IpadPlayPane in the phone split', () => {
  beforeEach(() => {
    // The Duo opened in landscape: an iPhone, so compact and sheet-only.
    cfg.width = 951;
    cfg.widthClass = 'compact';
    cfg.wallDeviceClass = 'sheet-only';
    cfg.presenceEnabled = true;
    cfg.presenceBoardId = 1;
    cfg.paneProps = { boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 1, setIds: '1', angle: 40 } };
    captured.playDrawerProps = null;
    captured.placeholderProps = null;
  });

  it('hands PlayDrawer the unlit board as its empty state and never docks a wall strip', () => {
    const { container } = render(<IpadPlayPane variant="phoneSplit" acceptsScrollHandoff />);
    expect(container.querySelector('[data-wall-strip="true"]')).toBeNull();
    expect(captured.playDrawerProps?.paneEmptyState).toBeDefined();
    expect(captured.playDrawerProps?.acceptsScrollHandoff).toBe(true);
    expect(captured.playDrawerProps?.paneTopInset).toBe(true);
  });

  it('offers the board picker when no board is chosen', () => {
    cfg.paneProps = null;
    render(<IpadPlayPane variant="phoneSplit" />);
    expect(captured.placeholderProps).toMatchObject({
      icon: 'boards',
      title: 'mobile.emptyState.noBoard.title',
      actionTitle: 'mobile.emptyState.noBoard.cta',
    });
  });
});
