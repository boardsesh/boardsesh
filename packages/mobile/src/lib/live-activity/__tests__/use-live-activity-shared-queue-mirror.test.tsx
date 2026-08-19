// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';

// iOS is the platform under test: only there does the native BoardBleManager
// relight the wall from the App-Group queue copy on connect, and only there
// does an EMPTY copy mean "clear the wall" (#4413). Platform.OS is read at
// module load, so it must be stubbed before the hook is imported.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

vi.mock('../../auth-store', () => ({
  getAuthToken: vi.fn().mockResolvedValue('token-123'),
}));

vi.mock('../../env', () => ({
  BACKEND_URL: 'https://backend.test',
  WEB_BASE_URL: 'https://web.test',
}));

// The hook lazily imports the bundled board-art manifest when it actually
// starts an Activity. No test here starts one, but stub it so a future case
// that does can't reach expo-asset.
vi.mock('../../background-image-cache', () => ({
  ensureBackgroundsCached: vi.fn().mockResolvedValue({ paths: [], missingCount: 0 }),
}));

const plugin = vi.hoisted(() => ({
  isLiveActivityAvailable: vi.fn(),
  startLiveActivitySession: vi.fn(),
  endLiveActivitySession: vi.fn(),
  updateLiveActivity: vi.fn(),
  updateLiveActivityClimb: vi.fn(),
}));

vi.mock('../live-activity-plugin', () => plugin);

import { useLiveActivity } from '../use-live-activity';

function makeQueueItem(uuid: string, frames: string): ClimbQueueItem {
  return {
    uuid: `queue-${uuid}`,
    climb: {
      uuid,
      name: `Climb ${uuid}`,
      difficulty: 'V4',
      angle: 40,
      frames,
      setter_username: 'setter',
      mirrored: false,
    },
  } as unknown as ClimbQueueItem;
}

const firstItem = makeQueueItem('climb-1', 'p1r1');
const secondItem = makeQueueItem('climb-2', 'p2r2');
// One stable array identity across rerenders, mirroring the reducer-owned queue:
// a fresh array would re-run the full queue sync and mask the lightweight
// climb-navigation push the mirror also has to make.
const soloQueue = [firstItem, secondItem];

type HookProps = Parameters<typeof useLiveActivity>[0];

// A climber who never started a session: sessionId null, so no Live Activity is
// raised — the exact population whose App-Group queue copy was always empty.
function soloProps(overrides: Partial<HookProps> = {}): HookProps {
  return {
    queue: soloQueue,
    currentClimbQueueItem: firstItem,
    board: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' },
    sessionId: null,
    isSessionActive: false,
    widgetNavigationAllowed: false,
    isPartySession: false,
    boardConnection: 'connectedByMe',
    ...overrides,
  };
}

function Harness(props: HookProps) {
  useLiveActivity(props);
  return null;
}

describe('useLiveActivity shared queue-state mirror (iOS)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    plugin.isLiveActivityAvailable.mockResolvedValue(true);
    plugin.updateLiveActivity.mockResolvedValue(undefined);
    plugin.updateLiveActivityClimb.mockResolvedValue(undefined);
    plugin.startLiveActivitySession.mockResolvedValue(undefined);
    plugin.endLiveActivitySession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes the queue and current index with no session, without starting an Activity', async () => {
    render(<Harness {...soloProps()} />);

    await waitFor(() => {
      expect(plugin.updateLiveActivity).toHaveBeenCalled();
    });

    const payload = plugin.updateLiveActivity.mock.calls[0][0];
    expect(payload.currentIndex).toBe(0);
    expect(payload.climbUuid).toBe('climb-1');
    expect(payload.queue.map((entry: { climbUuid: string }) => entry.climbUuid)).toEqual(['climb-1', 'climb-2']);
    // No session means no lock-screen widget — the mirror must not raise one.
    expect(plugin.startLiveActivitySession).not.toHaveBeenCalled();
  });

  it('publishes the new index when the climber navigates with no session', async () => {
    const { rerender } = render(<Harness {...soloProps()} />);

    await waitFor(() => {
      expect(plugin.updateLiveActivity).toHaveBeenCalled();
    });

    rerender(<Harness {...soloProps({ currentClimbQueueItem: secondItem })} />);

    await waitFor(() => {
      expect(plugin.updateLiveActivityClimb).toHaveBeenCalled();
    });
    const payload = plugin.updateLiveActivityClimb.mock.calls.at(-1)?.[0];
    expect(payload.currentIndex).toBe(1);
    expect(payload.climbUuid).toBe('climb-2');
  });

  it('still publishes when Live Activities are unavailable', async () => {
    // A climber who denied Live Activities in Settings still connects over BLE,
    // so the wall relight must not inherit ActivityKit's authorization.
    plugin.isLiveActivityAvailable.mockResolvedValue(false);

    render(<Harness {...soloProps()} />);

    await waitFor(() => {
      expect(plugin.updateLiveActivity).toHaveBeenCalled();
    });
    expect(plugin.startLiveActivitySession).not.toHaveBeenCalled();
  });

  it('does not publish before a board is selected', async () => {
    render(<Harness {...soloProps({ board: null })} />);

    await waitFor(() => {
      expect(plugin.isLiveActivityAvailable).toHaveBeenCalled();
    });
    expect(plugin.updateLiveActivity).not.toHaveBeenCalled();
    expect(plugin.updateLiveActivityClimb).not.toHaveBeenCalled();
  });

  it('leaves the previous copy alone when the queue empties', async () => {
    // Known gap, tracked in #4544: with nothing queued there is no item to
    // publish, so the App-Group copy keeps whatever it last held (and an
    // untouched copy at connect relights that instead of clearing the wall).
    const { rerender } = render(<Harness {...soloProps()} />);

    await waitFor(() => {
      expect(plugin.updateLiveActivity).toHaveBeenCalled();
    });
    const callsAfterFirstSync = plugin.updateLiveActivity.mock.calls.length;

    rerender(<Harness {...soloProps({ queue: [], currentClimbQueueItem: null })} />);

    await waitFor(() => {
      expect(plugin.updateLiveActivity.mock.calls.length).toBe(callsAfterFirstSync);
    });
  });

  it('re-publishes after a session ends, because endSession wipes the shared keys', async () => {
    const inSession = soloProps({ sessionId: 'session-1', isSessionActive: true });
    const { rerender } = render(<Harness {...inSession} />);

    await waitFor(() => {
      expect(plugin.startLiveActivitySession).toHaveBeenCalled();
    });
    plugin.updateLiveActivity.mockClear();

    rerender(<Harness {...soloProps()} />);

    await waitFor(() => {
      expect(plugin.endLiveActivitySession).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(plugin.updateLiveActivity).toHaveBeenCalled();
    });
  });
});
