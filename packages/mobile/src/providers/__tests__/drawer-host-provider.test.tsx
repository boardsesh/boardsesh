// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';

const queue = vi.hoisted(() => ({
  sessionId: 'session-1' as string | null,
  driverParticipantId: 'participant-other' as string | null,
  participantId: 'participant-self' as string | null,
  setCurrentClimb: vi.fn(),
  addToQueue: vi.fn(),
  setSessionBoardPath: vi.fn(async () => {}),
}));

const playDrawer = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
}));

const queueSheet = vi.hoisted(() => ({
  props: null as null | {
    visible: boolean;
    onClose: () => void;
    onDismissed: () => void;
    onClimbPress: (item: ClimbQueueItem) => void;
    onSuggestionPress: (climb: ClimbQueueItem['climb'], source: PlaylistSuggestionSource) => void;
  },
}));

const climbActions = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
}));

const activeBoard = vi.hoisted(() => ({
  stored: {
    uuid: 'board-1',
    slug: 'board-1',
    ownerId: 'owner-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2',
    name: 'Test board',
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
  } satisfies UserBoard,
  setActiveBoard: vi.fn(async () => {}),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
}));

vi.mock('react-native-screens', () => ({
  FullWindowOverlay: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'test-uuid',
}));

vi.mock('../../components/play-drawer', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    PlayDrawer: React.forwardRef((_props: unknown, ref) => {
      React.useImperativeHandle(ref, () => ({
        open: playDrawer.open,
        close: playDrawer.close,
      }));
      return React.createElement('div', { 'data-play-drawer': 'true' });
    }),
  };
});

vi.mock('../../components/play-drawer/QueueSheet', () => ({
  QueueSheet: (props: {
    visible: boolean;
    onClose: () => void;
    onDismissed: () => void;
    onClimbPress: (item: ClimbQueueItem) => void;
    onSuggestionPress: (climb: ClimbQueueItem['climb'], source: PlaylistSuggestionSource) => void;
  }) => {
    queueSheet.props = props;
    return createElement('div', { 'data-queue-sheet': 'true' });
  },
}));

vi.mock('../../components/LogAscentSheet', () => ({
  LogAscentSheet: () => createElement('div', { 'data-log-ascent': 'true' }),
}));
vi.mock('../../components/ClimbActionsSheet', () => ({
  ClimbActionsSheet: (props: Record<string, unknown>) => {
    climbActions.props = props;
    return createElement('div', { 'data-climb-actions': 'true' });
  },
}));
vi.mock('../../components/AddToPlaylistSheet', () => ({
  AddToPlaylistSheet: () => createElement('div', { 'data-add-to-playlist': 'true' }),
}));
vi.mock('../../components/QueueAddedSnackbar', () => ({
  QueueAddedSnackbar: () => createElement('div', { 'data-queue-snackbar': 'true' }),
}));

vi.mock('../queue-provider', () => ({
  useQueueActions: () => ({
    addToQueue: queue.addToQueue,
    setSessionBoardPath: queue.setSessionBoardPath,
    setCurrentClimb: queue.setCurrentClimb,
  }),
  useQueueSessionControls: () => ({
    sessionId: queue.sessionId,
    driverParticipantId: queue.driverParticipantId,
    participantId: queue.participantId,
  }),
}));

vi.mock('../queue-snackbar-provider', () => ({
  useQueueSnackbar: () => ({
    visible: false,
    nonce: 0,
    dismissSnackbar: vi.fn(),
  }),
}));

vi.mock('../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoard.stored }),
  useSetActiveBoard: () => activeBoard.setActiveBoard,
}));

vi.mock('../../lib/graphql/hooks', () => ({
  useToggleFavorite: () => ({ mutate: vi.fn() }),
  useProfile: () => ({ data: null }),
}));

vi.mock('../../lib/analytics', () => ({
  track: vi.fn(),
}));

vi.mock('../../lib/climb-to-queue-item', () => ({
  climbToQueueItem: (climb: ClimbQueueItem['climb'], options?: { suggested?: boolean }) => ({
    uuid: `queue-${climb.uuid}`,
    climb,
    suggested: options?.suggested ?? false,
  }),
}));

import { DrawerHostProvider, useDrawerHost } from '../drawer-host-provider';

function makeQueueItem(uuid: string, climbUuid = uuid): ClimbQueueItem {
  return {
    uuid,
    climb: {
      uuid: climbUuid,
      name: `Climb ${climbUuid}`,
      frames: 'p1r12',
      setter_username: 'setter',
      angle: 40,
      ascensionist_count: 0,
      difficulty: 'V3',
      quality_average: '3.0',
      stars: 3,
      difficulty_error: '0.3',
      benchmark_difficulty: null,
    },
  };
}

function Probe({ onHost }: { onHost: (host: ReturnType<typeof useDrawerHost>) => void }) {
  const host = useDrawerHost();
  useEffect(() => {
    onHost(host);
  }, [host, onHost]);
  return null;
}

function renderHost(onHost: (host: ReturnType<typeof useDrawerHost>) => void) {
  return render(createElement(DrawerHostProvider, null, createElement(Probe, { onHost })));
}

describe('DrawerHostProvider queue sheet wall-control gating', () => {
  beforeEach(() => {
    queue.sessionId = 'session-1';
    queue.driverParticipantId = 'participant-other';
    queue.participantId = 'participant-self';
    queue.setCurrentClimb.mockClear();
    queue.addToQueue.mockClear();
    queue.setSessionBoardPath.mockClear();
    activeBoard.setActiveBoard.mockClear();
    playDrawer.open.mockClear();
    playDrawer.close.mockClear();
    queueSheet.props = null;
    climbActions.props = null;
  });

  it('opens a preview without broadcasting when a party non-driver taps a queued climb', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    act(() => {
      hosts.at(-1)?.openQueueSheet();
    });
    await waitFor(() => expect(queueSheet.props).not.toBeNull());

    const item = makeQueueItem('queue-1', 'climb-1');
    act(() => {
      queueSheet.props?.onClimbPress(item);
    });

    expect(queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(playDrawer.open).toHaveBeenCalledWith(item.climb, { setAsCurrent: false, previewQueueItem: item });
  });

  it('opens a playlist preview without broadcasting when a party non-driver taps a suggestion', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    act(() => {
      hosts.at(-1)?.openQueueSheet();
    });
    await waitFor(() => expect(queueSheet.props).not.toBeNull());

    const sourceItem = makeQueueItem('queue-source', 'climb-source');
    const suggestion = makeQueueItem('queue-suggestion', 'climb-suggestion').climb;
    const playlistSuggestionSource: PlaylistSuggestionSource = {
      playlistUuid: 'playlist-1',
      activatedClimbUuid: sourceItem.climb.uuid,
      boardKey: 'kilter:1:10:1,2',
      climbs: [sourceItem.climb, suggestion],
    };

    act(() => {
      queueSheet.props?.onSuggestionPress(suggestion, playlistSuggestionSource);
    });

    expect(queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(playDrawer.open).toHaveBeenCalledWith(
      suggestion,
      expect.objectContaining({
        setAsCurrent: false,
        previewPlaylistSuggestionSource: playlistSuggestionSource,
        previewQueueItem: expect.objectContaining({
          climb: suggestion,
          suggested: true,
        }),
      }),
    );
  });

  it('broadcasts queued climb selection for the current party driver', async () => {
    queue.driverParticipantId = 'participant-self';
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    act(() => {
      hosts.at(-1)?.openQueueSheet();
    });
    await waitFor(() => expect(queueSheet.props).not.toBeNull());

    const item = makeQueueItem('queue-1', 'climb-1');
    act(() => {
      queueSheet.props?.onClimbPress(item);
    });

    expect(queue.setCurrentClimb).toHaveBeenCalledWith(item);
    expect(playDrawer.open).toHaveBeenCalledWith(item.climb, { setAsCurrent: false, previewQueueItem: item });
  });

  it('broadcasts suggestion selection for the current party driver while anchoring drawer navigation to that item', async () => {
    queue.driverParticipantId = 'participant-self';
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    act(() => {
      hosts.at(-1)?.openQueueSheet();
    });
    await waitFor(() => expect(queueSheet.props).not.toBeNull());

    const sourceItem = makeQueueItem('queue-source', 'climb-source');
    const suggestion = makeQueueItem('queue-suggestion', 'climb-suggestion').climb;
    const playlistSuggestionSource: PlaylistSuggestionSource = {
      playlistUuid: 'playlist-1',
      activatedClimbUuid: sourceItem.climb.uuid,
      boardKey: 'kilter:1:10:1,2',
      climbs: [sourceItem.climb, suggestion],
    };

    act(() => {
      queueSheet.props?.onSuggestionPress(suggestion, playlistSuggestionSource);
    });

    const suggestedItem = {
      uuid: `queue-${suggestion.uuid}`,
      climb: suggestion,
      suggested: true,
    };
    expect(queue.setCurrentClimb).toHaveBeenCalledWith(suggestedItem, {
      playlistSuggestionSource,
    });
    expect(playDrawer.open).toHaveBeenCalledWith(suggestion, {
      setAsCurrent: false,
      previewQueueItem: suggestedItem,
    });
  });
});

describe('DrawerHostProvider queue sheet open / re-open', () => {
  beforeEach(() => {
    queue.sessionId = 'session-1';
    queue.driverParticipantId = 'participant-other';
    queue.participantId = 'participant-self';
    queueSheet.props = null;
    climbActions.props = null;
  });

  it('presents the queue sheet on open (mount first, then visible on the next commit)', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    act(() => {
      hosts.at(-1)?.openQueueSheet();
    });

    await waitFor(() => expect(queueSheet.props?.visible).toBe(true));
  });

  it('re-presents the queue sheet when re-opened mid dismiss-animation, before it unmounts', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    act(() => {
      hosts.at(-1)?.openQueueSheet();
    });
    await waitFor(() => expect(queueSheet.props?.visible).toBe(true));

    // Animated close request: visible flips false but the sheet stays mounted
    // until its dismiss animation reports back via onDismissed (not fired here).
    act(() => {
      queueSheet.props?.onClose();
    });
    await waitFor(() => expect(queueSheet.props?.visible).toBe(false));

    // Re-open while still mounted. The fresh-mount path alone (set mounted only)
    // would no-op here — mounted is already true — and the mount effect would
    // never re-fire, leaving the sheet hidden. This guards the direct re-present.
    act(() => {
      hosts.at(-1)?.openQueueSheet();
    });
    await waitFor(() => expect(queueSheet.props?.visible).toBe(true));
  });

  it('unmounts after the dismiss animation completes, then re-opens cleanly', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    const { container } = renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    act(() => {
      hosts.at(-1)?.openQueueSheet();
    });
    await waitFor(() => expect(queueSheet.props?.visible).toBe(true));

    act(() => {
      queueSheet.props?.onClose(); // request animated close
    });
    act(() => {
      queueSheet.props?.onDismissed(); // animation finished → host unmounts the sheet
    });
    await waitFor(() => expect(container.querySelector('[data-queue-sheet]')).toBeNull());

    act(() => {
      hosts.at(-1)?.openQueueSheet();
    });
    await waitFor(() => expect(queueSheet.props?.visible).toBe(true));
  });
});

describe('DrawerHostProvider climb actions', () => {
  beforeEach(() => {
    queue.sessionId = 'session-1';
    queueSheet.props = null;
    climbActions.props = null;
  });

  it('opens the climb actions sheet for a climb against the active board, then closes it', async () => {
    const hosts: Array<ReturnType<typeof useDrawerHost>> = [];
    const { container } = renderHost((host) => hosts.push(host));
    await waitFor(() => expect(hosts.at(-1)).toBeDefined());

    expect(container.querySelector('[data-climb-actions]')).toBeNull();

    const climb = makeQueueItem('queue-x', 'climb-x').climb as unknown as Climb;
    act(() => {
      hosts.at(-1)?.openClimbActions(climb);
    });

    await waitFor(() => expect(container.querySelector('[data-climb-actions]')).not.toBeNull());
    // Snapshots the active board config (kilter / 1 / 10 / 1,2 / 40) at open time
    // and forwards it to the sheet so the preview thumbnail + actions resolve.
    expect(climbActions.props).toMatchObject({
      visible: true,
      climb,
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 40,
    });

    act(() => {
      hosts.at(-1)?.closeClimbActions();
    });
    await waitFor(() => expect(container.querySelector('[data-climb-actions]')).toBeNull());
  });
});
