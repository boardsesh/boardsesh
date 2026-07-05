// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

// The offline download toggle is feature-flagged: the manage screen passes
// `downloadState: undefined` when offline-board-downloads is off, and the row
// must then render no toggle and no offline status caption — the pre-offline UI.

const offlineToggleProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('../../SwipeableRow', () => ({
  SwipeableRow: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: () => createElement('div', { 'data-testid': 'board-image' }),
}));
vi.mock('../BoardOfflineToggle', () => ({
  BoardOfflineToggle: (props: Record<string, unknown>) => {
    offlineToggleProps.last = props;
    return createElement('div', { 'data-testid': 'offline-toggle' });
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../lib/board-details', () => ({
  // null → the row takes the fallback-icon branch; board art is irrelevant here.
  getBoardRenderData: () => null,
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: new Proxy({}, { get: () => 4 }),
  borderRadius: { lg: 12, md: 8, full: 999 },
}));
vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { systemGray4: '#ccc', systemRed: '#f00', systemOrange: '#fa0' },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      background: '#fff',
      separator: '#ccc',
      tertiaryBackground: '#eee',
      tertiaryLabel: '#999',
      secondaryLabel: '#888',
    },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span', { 'data-icon': 'true' }) }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('span') }));

import { BoardManageRow } from '../BoardManageRow';

const board = {
  uuid: 'board-1',
  name: 'Garage Kilter',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '26,27',
  sizeName: '12x12',
} as unknown as UserBoard;

const rowProps = {
  board,
  isOwned: true,
  isActive: false,
  isMutating: false,
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onUnfollow: vi.fn(),
  onToggleOffline: vi.fn(),
};

afterEach(() => {
  cleanup();
  offlineToggleProps.last = null;
});

describe('BoardManageRow offline toggle gating', () => {
  it('renders the offline toggle when a download state is provided (flag on)', () => {
    const { queryByTestId } = render(<BoardManageRow {...rowProps} downloadState="off" />);
    expect(queryByTestId('offline-toggle')).not.toBeNull();
    expect(offlineToggleProps.last?.state).toBe('off');
  });

  it('renders no toggle and no offline caption when downloadState is undefined (flag off)', () => {
    const { queryByTestId, queryByText } = render(<BoardManageRow {...rowProps} downloadState={undefined} />);
    expect(queryByTestId('offline-toggle')).toBeNull();
    // The status caption keys never render either — the row is the pre-offline two-liner.
    expect(queryByText('mobile.offline.available')).toBeNull();
    expect(queryByText('mobile.offline.pending')).toBeNull();
  });

  it('shows the downloaded caption when the flag is on and the board has landed', () => {
    const { queryByText } = render(<BoardManageRow {...rowProps} downloadState="downloaded" />);
    expect(queryByText('mobile.offline.available')).not.toBeNull();
    expect(offlineToggleProps.last?.state).toBe('downloaded');
  });
});
