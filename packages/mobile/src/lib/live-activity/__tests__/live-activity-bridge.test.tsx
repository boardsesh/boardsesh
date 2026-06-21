// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { LiveActivityBridge } from '../live-activity-bridge';

type QueueNavigateEvent = {
  action: 'next' | 'previous';
  currentIndex: number;
  correlationId: string;
};

type BoardControlEvent = {
  action: 'reconnect' | 'reassert';
  correlationId: string;
};

function makeItem(index: number): ClimbQueueItem {
  return {
    uuid: `queue-item-${index}`,
    climb: { uuid: `climb-${index}` },
  } as unknown as ClimbQueueItem;
}

const queue = vi.hoisted(() => ({
  sessionId: 'session-1' as string | null,
  dispatchWidgetNavigation: vi.fn(),
  state: {
    queue: [] as ClimbQueueItem[],
    currentClimbQueueItem: null as ClimbQueueItem | null,
  },
}));

const widget = vi.hoisted(() => ({
  listener: null as null | ((event: QueueNavigateEvent) => void),
  boardControlListener: null as null | ((event: BoardControlEvent) => void),
  useLiveActivity: vi.fn(),
}));

// Stand-in for the bluetooth context the lightbulb tap drives.
const bt = vi.hoisted(() => ({
  isConnected: true,
  loading: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
  armUndoWallChangeToast: vi.fn(),
  reassertWall: vi.fn(),
  reconnectSerialForCurrentBoard: 'serial-123' as string | null,
}));

const boardState = vi.hoisted(() => ({
  boardConnection: 'connectedByMe' as 'connectedByMe' | 'heldByPeer' | 'disconnected',
  holderDisplayName: null as string | null,
  hasBluetooth: true,
}));

const climbRender = vi.hoisted(() => ({
  overlayUri: null as string | null,
  backgroundPaths: [] as string[],
}));

const analytics = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../analytics', () => ({ track: analytics.track }));

vi.mock('../../../providers/queue-provider', () => ({
  useQueue: () => ({
    state: queue.state,
    sessionId: queue.sessionId,
    dispatchWidgetNavigation: queue.dispatchWidgetNavigation,
  }),
}));

vi.mock('../../../components/ble/use-board-connection-state', () => ({
  useBoardConnectionState: () => ({
    bluetooth: boardState.hasBluetooth ? bt : null,
    localConnected: boardState.boardConnection === 'connectedByMe',
    pending: false,
    sessionId: queue.sessionId,
    boardConnection: boardState.boardConnection,
    lit: boardState.boardConnection !== 'disconnected',
    holderDisplayName: boardState.holderDisplayName,
  }),
}));

vi.mock('../../../hooks/use-native-climb-render', () => ({
  useNativeClimbRender: () => ({
    overlayUri: climbRender.overlayUri,
    backgroundPaths: climbRender.backgroundPaths,
    missingBackgroundCount: 0,
  }),
}));

vi.mock('../use-live-activity', () => ({
  useLiveActivity: (args: unknown) => widget.useLiveActivity(args),
}));

vi.mock('../live-activity-plugin', () => ({
  addWidgetQueueNavigateListener: (listener: (event: QueueNavigateEvent) => void) => {
    widget.listener = listener;
    return () => {
      widget.listener = null;
    };
  },
  addBoardControlListener: (listener: (event: BoardControlEvent) => void) => {
    widget.boardControlListener = listener;
    return () => {
      widget.boardControlListener = null;
    };
  },
  isAndroidSessionPresence: true,
}));

const climbItem = makeItem(0);

function renderBridge() {
  return render(<LiveActivityBridge boardName="kilter" layoutId={1} sizeId={10} setIds="1,2" />);
}

describe('LiveActivityBridge widget navigation (always-live)', () => {
  const threeItemQueue = [makeItem(0), makeItem(1), makeItem(2)];

  beforeEach(() => {
    queue.sessionId = 'session-1';
    queue.state = { queue: threeItemQueue, currentClimbQueueItem: threeItemQueue[0] };
    queue.dispatchWidgetNavigation.mockClear();
    widget.listener = null;
    widget.boardControlListener = null;
    widget.useLiveActivity.mockClear();
    boardState.boardConnection = 'connectedByMe';
    boardState.holderDisplayName = null;
    boardState.hasBluetooth = true;
    bt.connect.mockClear();
    bt.armUndoWallChangeToast.mockClear();
    bt.reassertWall.mockClear();
    bt.reconnectSerialForCurrentBoard = 'serial-123';
  });

  it('passes connectedByMe + enables widget navigation when this device holds the board', () => {
    renderBridge();

    expect(widget.useLiveActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        boardConnection: 'connectedByMe',
        widgetNavigationAllowed: true,
        holderDisplayName: null,
      }),
    );
  });

  it('hides widget navigation (and surfaces the holder) once a peer takes the board', () => {
    boardState.boardConnection = 'heldByPeer';
    boardState.holderDisplayName = 'Alex';
    renderBridge();

    expect(widget.useLiveActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        boardConnection: 'heldByPeer',
        widgetNavigationAllowed: false,
        holderDisplayName: 'Alex',
      }),
    );
  });

  it('hides widget navigation when nobody is driving the board', () => {
    boardState.boardConnection = 'disconnected';
    renderBridge();

    expect(widget.useLiveActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        boardConnection: 'disconnected',
        widgetNavigationAllowed: false,
      }),
    );
  });

  it('navigates to the absolute index the widget reports (not a relative step)', () => {
    renderBridge();

    act(() => {
      widget.listener?.({ action: 'next', currentIndex: 1, correlationId: 'widget-navigate' });
    });

    // Maps currentIndex → queue[currentIndex] and forwards the correlationId so
    // the racing CurrentClimbChanged echo is suppressed by the reducer.
    expect(queue.dispatchWidgetNavigation).toHaveBeenCalledTimes(1);
    expect(queue.dispatchWidgetNavigation).toHaveBeenCalledWith(threeItemQueue[1], 'widget-navigate');
  });

  it('does not double-advance: a single tap dispatches exactly one absolute move', () => {
    renderBridge();

    act(() => {
      widget.listener?.({ action: 'previous', currentIndex: 0, correlationId: 'widget-navigate' });
    });

    expect(queue.dispatchWidgetNavigation).toHaveBeenCalledTimes(1);
    expect(queue.dispatchWidgetNavigation).toHaveBeenCalledWith(threeItemQueue[0], 'widget-navigate');
  });

  it('ignores out-of-range indices instead of wrapping or crashing', () => {
    renderBridge();

    act(() => {
      widget.listener?.({ action: 'next', currentIndex: 99, correlationId: 'widget-navigate' });
      widget.listener?.({ action: 'previous', currentIndex: -1, correlationId: 'widget-navigate' });
    });

    expect(queue.dispatchWidgetNavigation).not.toHaveBeenCalled();
  });

  it('always allows widget navigation in a party session (no driver gate)', () => {
    renderBridge();

    expect(widget.useLiveActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        widgetNavigationAllowed: true,
        isPartySession: true,
      }),
    );
  });

  it('allows widget navigation outside sessions', () => {
    queue.sessionId = null;
    renderBridge();

    act(() => {
      widget.listener?.({ action: 'next', currentIndex: 1, correlationId: 'widget-navigate' });
    });

    expect(queue.dispatchWidgetNavigation).toHaveBeenCalledWith(threeItemQueue[1], 'widget-navigate');
    expect(widget.useLiveActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        widgetNavigationAllowed: true,
        isPartySession: false,
      }),
    );
  });
});

describe('LiveActivityBridge lightbulb (boardControl)', () => {
  beforeEach(() => {
    queue.sessionId = 'session-1';
    queue.state = { queue: [climbItem], currentClimbQueueItem: climbItem };
    widget.boardControlListener = null;
    widget.useLiveActivity.mockClear();
    boardState.boardConnection = 'connectedByMe';
    boardState.holderDisplayName = null;
    boardState.hasBluetooth = true;
    bt.connect.mockClear();
    bt.armUndoWallChangeToast.mockClear();
    bt.reassertWall.mockClear();
    bt.reconnectSerialForCurrentBoard = 'serial-123';
    analytics.track.mockClear();
    climbRender.overlayUri = null;
    climbRender.backgroundPaths = [];
  });

  it('threads the on-device thumbnail (overlay + background paths) to the notification', () => {
    climbRender.overlayUri = 'file:///cache/overlay.png';
    climbRender.backgroundPaths = ['/assets/kilter-bg.png'];
    renderBridge();

    expect(widget.useLiveActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        androidThumbnailOverlayPath: 'file:///cache/overlay.png',
        androidThumbnailBackgroundPaths: ['/assets/kilter-bg.png'],
      }),
    );
  });

  it('forwards the localized lightbulb labels + on-wall template to the notification', () => {
    renderBridge();

    expect(widget.useLiveActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        androidNotification: expect.objectContaining({
          relightLabel: 'mobile.session.notification.relight',
          reconnectLabel: 'mobile.session.notification.reconnect',
          onWallTemplate: 'mobile.session.notification.onWall',
        }),
      }),
    );
  });

  it('reconnect: re-lights via connect to the remembered board serial', () => {
    renderBridge();

    act(() => {
      widget.boardControlListener?.({ action: 'reconnect', correlationId: 'bulb-1' });
    });

    expect(bt.armUndoWallChangeToast).toHaveBeenCalledTimes(1);
    expect(bt.connect).toHaveBeenCalledTimes(1);
    expect(bt.connect).toHaveBeenCalledWith(undefined, undefined, 'serial-123');
    expect(bt.reassertWall).not.toHaveBeenCalled();
    // The lock-screen reconnect is measured like the in-app bulb.
    expect(analytics.track).toHaveBeenCalledWith(
      'Board Lightbulb Connect',
      expect.objectContaining({ source: 'notification', mode: 'party' }),
    );
  });

  it('reconnect: tags the analytics mode as solo when not in a party session', () => {
    queue.sessionId = null;
    renderBridge();

    act(() => {
      widget.boardControlListener?.({ action: 'reconnect', correlationId: 'bulb-solo' });
    });

    expect(analytics.track).toHaveBeenCalledWith(
      'Board Lightbulb Connect',
      expect.objectContaining({ source: 'notification', mode: 'solo' }),
    );
  });

  it('reconnect: falls back to undefined serial (board picker) when none is remembered', () => {
    bt.reconnectSerialForCurrentBoard = null;
    renderBridge();

    act(() => {
      widget.boardControlListener?.({ action: 'reconnect', correlationId: 'bulb-2' });
    });

    expect(bt.connect).toHaveBeenCalledWith(undefined, undefined, undefined);
  });

  it('reassert: re-pushes the current climb without reconnecting (no undo toast — nothing changed)', () => {
    renderBridge();

    act(() => {
      widget.boardControlListener?.({ action: 'reassert', correlationId: 'bulb-3' });
    });

    expect(bt.armUndoWallChangeToast).not.toHaveBeenCalled();
    expect(bt.reassertWall).toHaveBeenCalledTimes(1);
    expect(bt.connect).not.toHaveBeenCalled();
  });

  it('is a no-op (no throw) when no board is selected', () => {
    boardState.hasBluetooth = false;
    renderBridge();

    expect(() => {
      act(() => {
        widget.boardControlListener?.({ action: 'reconnect', correlationId: 'bulb-4' });
        widget.boardControlListener?.({ action: 'reassert', correlationId: 'bulb-5' });
      });
    }).not.toThrow();
    expect(bt.connect).not.toHaveBeenCalled();
    expect(bt.reassertWall).not.toHaveBeenCalled();
  });
});

describe('LiveActivityBridge session-presence gating', () => {
  beforeEach(() => {
    queue.sessionId = 'session-1';
    queue.state = { queue: [], currentClimbQueueItem: null };
    widget.useLiveActivity.mockClear();
    boardState.boardConnection = 'connectedByMe';
    boardState.holderDisplayName = null;
  });

  it('keeps a solo queue (no session) out of session presence', () => {
    queue.sessionId = null;
    queue.state = { queue: [climbItem], currentClimbQueueItem: climbItem };
    renderBridge();

    expect(widget.useLiveActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        isSessionActive: false,
      }),
    );
  });

  it('marks an explicit session active even before any climb is queued', () => {
    renderBridge();

    expect(widget.useLiveActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        isSessionActive: true,
      }),
    );
  });
});
