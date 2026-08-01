// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

// The offline download toggle is feature-flagged: the manage screen passes
// `downloadState: undefined` when offline-board-downloads is off, and the row
// must then render no toggle and no offline status caption — the pre-offline UI.

const offlineToggleProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
const swipeableProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
const platformState = vi.hoisted(() => ({ OS: 'ios' }));
const accessibilitySpies = vi.hoisted(() => ({ announce: vi.fn() }));

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: accessibilitySpies.announce },
  Platform: platformState,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('../../SwipeableRow', () => ({
  SwipeableRow: (props: { children?: ReactNode }) => {
    // Recorded, not just rendered: `onPress` (tap-to-edit) and `enabled` (the swipe
    // delete/unfollow) are the affordances read-only mode has to take away, and both
    // live on this wrapper rather than in the row's own markup.
    swipeableProps.last = props as Record<string, unknown>;
    return createElement('div', null, props.children);
  },
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
  Text: ({
    children,
    accessibilityLabel,
    accessibilityLiveRegion,
    numberOfLines,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityLiveRegion?: 'none' | 'polite' | 'assertive';
    numberOfLines?: number;
  }) =>
    createElement(
      'span',
      {
        'aria-label': accessibilityLabel,
        'data-live-region': accessibilityLiveRegion,
        'data-number-of-lines': numberOfLines,
      },
      children,
    ),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
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
  swipeableProps.last = null;
  platformState.OS = 'ios';
  accessibilitySpies.announce.mockReset();
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

  it('shows the bootstrapping caption (not the climb count) during the snapshot warm-up', () => {
    const { queryByText } = render(
      <BoardManageRow {...rowProps} downloadState="downloading" isBootstrapping downloadCount={0} />,
    );
    expect(queryByText('mobile.offline.bootstrapping')).not.toBeNull();
    expect(queryByText('mobile.offline.downloadingCount')).toBeNull();
  });

  it('lets active bootstrap outrank a stale paged-fallback notice', () => {
    const { queryByText } = render(
      <BoardManageRow {...rowProps} downloadState="downloading" isBootstrapping downloadNotice="paged-fallback" />,
    );
    expect(queryByText('mobile.offline.bootstrapping')).not.toBeNull();
    expect(queryByText('mobile.offline.pagedFallbackActive')).toBeNull();
    expect(queryByText('mobile.offline.pagedFallbackPending')).toBeNull();
  });

  it('shows the live climb count caption during the paged crawl (not bootstrapping)', () => {
    const { queryByText } = render(<BoardManageRow {...rowProps} downloadState="downloading" downloadCount={42} />);
    expect(queryByText('mobile.offline.downloadingCount')).not.toBeNull();
    expect(queryByText('mobile.offline.bootstrapping')).toBeNull();
  });

  it('shows the full retry notice as an accessible status without changing the toggle state', () => {
    const { getByText } = render(
      <BoardManageRow {...rowProps} downloadState="pending" downloadNotice="snapshot-retrying" />,
    );
    const notice = getByText('mobile.offline.snapshotRetrying');
    expect(notice.getAttribute('aria-label')).toBe('mobile.offline.snapshotRetryingAria');
    expect(notice.getAttribute('data-number-of-lines')).toBeNull();
    expect(notice.getAttribute('data-live-region')).toBeNull();
    expect(offlineToggleProps.last?.state).toBe('pending');
  });

  it('distinguishes pending fallback from an active paged crawl', () => {
    const { queryByText, rerender } = render(
      <BoardManageRow {...rowProps} downloadState="pending" downloadNotice="paged-fallback" />,
    );
    expect(queryByText('mobile.offline.pagedFallbackPending')).not.toBeNull();
    expect(queryByText('mobile.offline.pagedFallbackActive')).toBeNull();

    rerender(
      <BoardManageRow {...rowProps} downloadState="downloading" downloadCount={42} downloadNotice="paged-fallback" />,
    );
    expect(queryByText('mobile.offline.pagedFallbackPending')).toBeNull();
    expect(queryByText('mobile.offline.pagedFallbackActive')).not.toBeNull();
    expect(queryByText('mobile.offline.downloadingCount')).not.toBeNull();
  });

  it('announces iOS notice transitions once and ignores count-only updates', () => {
    const { getByText, rerender } = render(<BoardManageRow {...rowProps} downloadState="pending" />);

    rerender(<BoardManageRow {...rowProps} downloadState="pending" downloadNotice="snapshot-retrying" />);
    expect(accessibilitySpies.announce).toHaveBeenCalledTimes(1);
    expect(accessibilitySpies.announce).toHaveBeenLastCalledWith('mobile.offline.snapshotRetryingAria');

    rerender(<BoardManageRow {...rowProps} downloadState="pending" downloadNotice="paged-fallback" />);
    expect(accessibilitySpies.announce).toHaveBeenCalledTimes(2);
    expect(accessibilitySpies.announce).toHaveBeenLastCalledWith('mobile.offline.pagedFallbackPendingAria');

    rerender(
      <BoardManageRow {...rowProps} downloadState="downloading" downloadCount={1} downloadNotice="paged-fallback" />,
    );
    expect(accessibilitySpies.announce).toHaveBeenCalledTimes(3);
    expect(accessibilitySpies.announce).toHaveBeenLastCalledWith('mobile.offline.pagedFallbackActiveAria');
    expect(getByText('mobile.offline.downloadingCount').getAttribute('data-live-region')).toBe('none');

    rerender(
      <BoardManageRow {...rowProps} downloadState="downloading" downloadCount={42} downloadNotice="paged-fallback" />,
    );
    expect(accessibilitySpies.announce).toHaveBeenCalledTimes(3);
    expect(getByText('mobile.offline.downloadingCount').getAttribute('data-live-region')).toBe('none');
  });

  it('clears iOS announcement memory when a notice disappears', () => {
    const { rerender } = render(<BoardManageRow {...rowProps} downloadState="pending" />);
    rerender(<BoardManageRow {...rowProps} downloadState="pending" downloadNotice="snapshot-retrying" />);
    rerender(<BoardManageRow {...rowProps} downloadState="pending" />);
    rerender(<BoardManageRow {...rowProps} downloadState="pending" downloadNotice="snapshot-retrying" />);

    expect(accessibilitySpies.announce).toHaveBeenCalledTimes(2);
  });

  it('uses one Android polite live region without an imperative announcement', () => {
    platformState.OS = 'android';
    const { container, getByText, rerender } = render(<BoardManageRow {...rowProps} downloadState="pending" />);

    rerender(<BoardManageRow {...rowProps} downloadState="pending" downloadNotice="snapshot-retrying" />);

    expect(getByText('mobile.offline.snapshotRetrying').getAttribute('data-live-region')).toBe('polite');
    expect(container.querySelectorAll('[data-live-region="polite"]')).toHaveLength(1);
    expect(accessibilitySpies.announce).not.toHaveBeenCalled();
  });

  it('keeps ordinary compact status text to one line', () => {
    const { getByText } = render(<BoardManageRow {...rowProps} downloadState="pending" />);
    expect(getByText('mobile.offline.pending').getAttribute('data-number-of-lines')).toBe('1');
  });
});

describe('BoardManageRow read-only mode', () => {
  // #3897: with no usable connection every row affordance except the offline toggle is
  // a server mutation, so the row must not offer them at all — a swipe-to-delete that
  // can only fail is worse than no swipe.
  it('offers tap-to-edit, the swipe action and the chevron by default', () => {
    const { container } = render(<BoardManageRow {...rowProps} downloadState={undefined} />);
    expect(swipeableProps.last?.onPress).toBeTypeOf('function');
    expect(swipeableProps.last?.enabled).toBe(true);
    expect(container.querySelector('[data-icon="chevron.right"]')).not.toBeNull();
  });

  it('takes all three away when read-only', () => {
    const { container } = render(<BoardManageRow {...rowProps} readOnly downloadState={undefined} />);
    expect(swipeableProps.last?.onPress).toBeUndefined();
    expect(swipeableProps.last?.pressAccessibilityLabel).toBeUndefined();
    expect(swipeableProps.last?.enabled).toBe(false);
    expect(container.querySelector('[data-icon="chevron.right"]')).toBeNull();
  });

  it('keeps the offline toggle, which is a local write', () => {
    const onToggleOffline = vi.fn();
    const { getByTestId } = render(
      <BoardManageRow {...rowProps} readOnly downloadState="downloaded" onToggleOffline={onToggleOffline} />,
    );
    expect(getByTestId('offline-toggle')).not.toBeNull();
    const toggleOnPress = offlineToggleProps.last?.onPress;
    expect(toggleOnPress).toBeTypeOf('function');
    (toggleOnPress as () => void)();
    expect(onToggleOffline).toHaveBeenCalledWith(board);
  });
});

describe('BoardManageRow edit mode', () => {
  it('renders no persistent remove control outside edit mode', () => {
    const { queryByLabelText } = render(<BoardManageRow {...rowProps} isOwned={false} downloadState={undefined} />);
    expect(queryByLabelText('mobile.manage.unfollowAria')).toBeNull();
  });

  it('unfollows a followed board via the persistent remove control in edit mode', () => {
    const onUnfollow = vi.fn();
    const { getByLabelText } = render(
      <BoardManageRow {...rowProps} isOwned={false} isEditing onUnfollow={onUnfollow} downloadState={undefined} />,
    );
    getByLabelText('mobile.manage.unfollowAria').click();
    expect(onUnfollow).toHaveBeenCalledWith(board);
  });

  it('deletes an owned board via the persistent remove control in edit mode', () => {
    const onDelete = vi.fn();
    const { getByLabelText } = render(
      <BoardManageRow {...rowProps} isOwned isEditing onDelete={onDelete} downloadState={undefined} />,
    );
    getByLabelText('mobile.manage.deleteAria').click();
    expect(onDelete).toHaveBeenCalledWith(board);
  });
});
