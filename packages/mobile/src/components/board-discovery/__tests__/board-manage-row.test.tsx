// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

// The offline download toggle is feature-flagged: the manage screen passes
// `downloadState: undefined` when offline-board-downloads is off, and the row
// must then render no toggle and no offline status caption — the pre-offline UI.

const offlineToggleProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
const platformState = vi.hoisted(() => ({ OS: 'ios' }));
const accessibilitySpies = vi.hoisted(() => ({ announce: vi.fn() }));
// Every t() call with its interpolation values, so the progress caption's
// numbers can be asserted while t() keeps returning the bare key for the
// existing key-presence assertions.
const translationCalls = vi.hoisted(() => ({ calls: [] as Array<{ key: string; options?: Record<string, unknown> }> }));
const progressBarProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null, renderCount: 0 }));

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

vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: () => createElement('div', { 'data-testid': 'board-image' }),
}));
vi.mock('../OfflineDownloadProgressBar', () => ({
  OfflineDownloadProgressBar: (props: Record<string, unknown>) => {
    progressBarProps.last = props;
    progressBarProps.renderCount += 1;
    return createElement('div', { 'data-testid': 'download-progress-bar' });
  },
}));
vi.mock('../BoardOfflineToggle', () => ({
  BoardOfflineToggle: (props: Record<string, unknown>) => {
    offlineToggleProps.last = props;
    return createElement('div', { 'data-testid': 'offline-toggle' });
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      translationCalls.calls.push({ key, options });
      return key;
    },
    i18n: { language: 'en-US' },
  }),
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
  onToggleOffline: vi.fn(),
};

afterEach(() => {
  cleanup();
  offlineToggleProps.last = null;
  platformState.OS = 'ios';
  accessibilitySpies.announce.mockReset();
  translationCalls.calls = [];
  progressBarProps.last = null;
  progressBarProps.renderCount = 0;
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

  it('shows a finishing caption while shared post-download work is still running', () => {
    const { queryByText } = render(<BoardManageRow {...rowProps} downloadState="finalizing" />);
    expect(queryByText('mobile.offline.finalizing')).not.toBeNull();
    expect(queryByText('mobile.offline.pending')).toBeNull();
    expect(offlineToggleProps.last?.state).toBe('finalizing');
  });

  it('shows the bootstrapping caption (not the climb count) during the snapshot warm-up', () => {
    const { queryByText } = render(
      <BoardManageRow {...rowProps} downloadState="downloading" isBootstrapping downloadCount={0} />,
    );
    expect(queryByText('mobile.offline.bootstrapping')).not.toBeNull();
    expect(queryByText('mobile.offline.downloadingCount')).toBeNull();
  });

  it('renders wire-scale megabytes during the download stage — the same scale the confirm dialog quoted', () => {
    render(
      <BoardManageRow
        {...rowProps}
        downloadState="downloading"
        isBootstrapping
        downloadProgress={{ stage: 'download', fraction: 0.408, bytesDone: 42_000_000, bytesTotal: 103_000_000 }}
      />,
    );

    const caption = translationCalls.calls.find((call) => call.key === 'mobile.offline.bootstrapDownloading');
    expect(caption?.options).toEqual({ done: '42 MB', total: '103 MB' });
    // The 271 MB decoded figure can't reach the caption: the row is only ever
    // handed wire-scale numbers.
    expect(JSON.stringify(translationCalls.calls)).not.toContain('271');
    expect(progressBarProps.last?.fraction).toBe(0.408);
  });

  it('falls back to a size-only caption and an empty bar when the fraction is indeterminate', () => {
    render(
      <BoardManageRow
        {...rowProps}
        downloadState="downloading"
        isBootstrapping
        downloadProgress={{ stage: 'download', fraction: null, bytesDone: null, bytesTotal: 103_000_000 }}
      />,
    );

    const caption = translationCalls.calls.find((call) => call.key === 'mobile.offline.bootstrapDownloadingUnknown');
    expect(caption?.options).toEqual({ total: '103 MB' });
    expect(progressBarProps.last?.fraction).toBeNull();
  });

  it('captions the manifest and import stages distinctly', () => {
    const { queryByText } = render(
      <BoardManageRow
        {...rowProps}
        downloadState="downloading"
        isBootstrapping
        downloadProgress={{ stage: 'manifest', fraction: null, bytesDone: null, bytesTotal: null }}
      />,
    );
    expect(queryByText('mobile.offline.bootstrapPreparing')).not.toBeNull();
    cleanup();

    const importing = render(
      <BoardManageRow
        {...rowProps}
        downloadState="downloading"
        isBootstrapping
        downloadProgress={{ stage: 'import', fraction: null, bytesDone: null, bytesTotal: 103_000_000 }}
      />,
    );
    expect(importing.queryByText('mobile.offline.bootstrapImporting')).not.toBeNull();
    // The bar is only meaningful while bytes are moving.
    expect(progressBarProps.last?.fraction).toBeUndefined();
  });

  it('keeps the legacy caption when no progress frame has arrived (flag off, or a downloader that never reports)', () => {
    const { queryByText } = render(
      <BoardManageRow {...rowProps} downloadState="downloading" isBootstrapping downloadProgress={null} />,
    );
    expect(queryByText('mobile.offline.bootstrapping')).not.toBeNull();
    expect(queryByText('mobile.offline.bootstrapDownloading')).toBeNull();
  });

  it('reserves the progress bar on every downloadable row, so the first frame cannot change row height', () => {
    // A bar that only appears once bytes arrive would resize the row inside the
    // FlashList and jump the scroll position under the climber's thumb.
    const idle = render(<BoardManageRow {...rowProps} downloadState="pending" />);
    expect(idle.queryByTestId('download-progress-bar')).not.toBeNull();
    expect(progressBarProps.last?.fraction).toBeUndefined();
    cleanup();

    const downloading = render(
      <BoardManageRow
        {...rowProps}
        downloadState="downloading"
        isBootstrapping
        downloadProgress={{ stage: 'download', fraction: 0.5, bytesDone: 51_500_000, bytesTotal: 103_000_000 }}
      />,
    );
    expect(downloading.queryByTestId('download-progress-bar')).not.toBeNull();
    cleanup();

    // …and never on a row that can't download at all (offline flag off).
    const flagOff = render(<BoardManageRow {...rowProps} downloadState={undefined} />);
    expect(flagOff.queryByTestId('download-progress-bar')).toBeNull();
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

describe('BoardManageRow affordances', () => {
  // #4623 collapsed /boards and /boards/manage: editing, deleting and unfollowing a
  // board moved onto the board cards in the picker, so this row keeps exactly one
  // affordance — the offline toggle, which is a local write and works with no signal.
  it('keeps the offline toggle, which is a local write', () => {
    const onToggleOffline = vi.fn();
    const { getByTestId } = render(
      <BoardManageRow {...rowProps} downloadState="downloaded" onToggleOffline={onToggleOffline} />,
    );
    expect(getByTestId('offline-toggle')).not.toBeNull();
    const toggleOnPress = offlineToggleProps.last?.onPress;
    expect(toggleOnPress).toBeTypeOf('function');
    (toggleOnPress as () => void)();
    expect(onToggleOffline).toHaveBeenCalledWith(board);
  });
});

describe('BoardManageRow subtitle', () => {
  // The server sends sizeName as null on every board, so the old
  // `board.sizeName ?? ...` first term never fired and every row read "Kilter".
  it('shows where an owned board is', () => {
    const gymBoard = { ...board, gymName: 'Bergen Klatresenter', sizeName: null } as unknown as UserBoard;
    const { queryByText } = render(<BoardManageRow {...rowProps} board={gymBoard} downloadState={undefined} />);
    expect(queryByText('Bergen Klatresenter')).not.toBeNull();
  });

  it('falls back to what an owned board is when it has no place', () => {
    const placeless = { ...board, sizeName: null } as unknown as UserBoard;
    const { queryByText } = render(<BoardManageRow {...rowProps} board={placeless} downloadState={undefined} />);
    expect(queryByText('Original 12×12 with kickboard')).not.toBeNull();
  });

  // This is the ONLY place in the app that answers "whose board is this": the
  // group header is a static "Following" that names nobody, and the picker's
  // cards have never shown an owner. Losing it would make two same-titled gym
  // boards indistinguishable.
  it('shows the owner on a followed board', () => {
    const followed = { ...board, ownerDisplayName: 'Marco' } as unknown as UserBoard;
    const { queryByText } = render(
      <BoardManageRow {...rowProps} board={followed} isOwned={false} downloadState={undefined} />,
    );
    expect(queryByText('Marco')).not.toBeNull();
  });

  // The other half of the same branch: the owner fallback must never fire on a
  // board the viewer owns, or every one of their walls reads as their own name.
  it('never subtitles a board the viewer owns with their own name', () => {
    const withOwner = { ...board, ownerDisplayName: 'Marco' } as unknown as UserBoard;
    const { queryByText } = render(<BoardManageRow {...rowProps} board={withOwner} downloadState={undefined} />);
    expect(queryByText('Marco')).toBeNull();
    expect(queryByText('Original 12×12 with kickboard')).not.toBeNull();
  });

  // A followed board whose wire row carries no owner still needs a subtitle.
  it('falls back to what a followed board is when it has no owner name', () => {
    const anonymous = { ...board, ownerDisplayName: null } as unknown as UserBoard;
    const { queryByText } = render(
      <BoardManageRow {...rowProps} board={anonymous} isOwned={false} downloadState={undefined} />,
    );
    expect(queryByText('Original 12×12 with kickboard')).not.toBeNull();
  });
});
