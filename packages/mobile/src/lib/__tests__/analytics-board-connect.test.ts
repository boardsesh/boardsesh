// Board Connect Tapped (#5654) and what a picker session reads from it (2.7
// release watch): the board a tap is for, whether this phone ever connected,
// and the surface a picker list opening now belongs to.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const firstConnect = vi.hoisted(() => ({ device: null as { connectedAt: number | null } | null }));
vi.mock('../analytics', () => ({ track: analytics.track }));
vi.mock('../onboarding/first-connect-store', () => ({
  getFirstConnectSnapshot: () => ({ device: firstConnect.device }),
}));

import {
  BOARD_CONNECT_ENTRY_WINDOW_MS,
  readPhoneNeverConnected,
  readRecentBoardConnectSurface,
  registerConnectBoardUuidReader,
  resetBoardConnectTapsForTests,
  trackBoardConnectTapped,
} from '../analytics-board-connect';

const tapped = () => analytics.track.mock.calls.filter(([name]) => name === 'Board Connect Tapped');

beforeEach(() => {
  analytics.track.mockClear();
  firstConnect.device = null;
  resetBoardConnectTapsForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Board Connect Tapped', () => {
  it('sends what it always sent while the board and the phone are unknown', () => {
    trackBoardConnectTapped({ surface: 'toolbar', boardName: 'kilter', reconnect: false });
    expect(tapped()).toEqual([['Board Connect Tapped', { surface: 'toolbar', boardName: 'kilter', reconnect: false }]]);
  });

  it("names the provider's board, or the board a move goes to", () => {
    const release = registerConnectBoardUuidReader(() => 'gym-kilter');
    trackBoardConnectTapped({ surface: 'play_drawer', boardName: 'kilter', reconnect: true });
    trackBoardConnectTapped({
      surface: 'move_to_board',
      boardName: 'moonboard',
      reconnect: false,
      boardUuid: 'gym-moon',
    });
    release();
    trackBoardConnectTapped({ surface: 'toolbar', boardName: 'kilter', reconnect: false });
    expect(tapped().map(([, props]) => props)).toEqual([
      { surface: 'play_drawer', boardName: 'kilter', reconnect: true, boardUuid: 'gym-kilter' },
      { surface: 'move_to_board', boardName: 'moonboard', reconnect: false, boardUuid: 'gym-moon' },
      { surface: 'toolbar', boardName: 'kilter', reconnect: false },
    ]);
  });

  it('says whether this phone has ever connected, once its history has loaded', () => {
    firstConnect.device = { connectedAt: null };
    trackBoardConnectTapped({ surface: 'first_connect_card', boardName: 'kilter', reconnect: false });
    firstConnect.device = { connectedAt: 1_700_000_000_000 };
    trackBoardConnectTapped({ surface: 'toolbar', boardName: 'kilter', reconnect: true });
    expect(tapped().map(([, props]) => props)).toEqual([
      expect.objectContaining({ phoneNeverConnected: true }),
      expect.objectContaining({ phoneNeverConnected: false }),
    ]);
    expect(readPhoneNeverConnected()).toBe(false);
    firstConnect.device = null;
    expect(readPhoneNeverConnected()).toBeNull();
  });

  it('keeps an older reader from clearing a newer one', () => {
    const releaseOlder = registerConnectBoardUuidReader(() => 'old');
    const releaseNewer = registerConnectBoardUuidReader(() => 'new');
    releaseOlder();
    trackBoardConnectTapped({ surface: 'toolbar', boardName: 'kilter', reconnect: false });
    expect(tapped()[0]?.[1]).toMatchObject({ boardUuid: 'new' });
    releaseNewer();
  });
});

describe('the surface a picker list belongs to', () => {
  it('is the last connect tap, for two minutes', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
    expect(readRecentBoardConnectSurface()).toBeNull();
    trackBoardConnectTapped({ surface: 'put_on_wall', boardName: 'kilter', reconnect: false });
    trackBoardConnectTapped({ surface: 'picker_scan_again', boardName: 'kilter', reconnect: false });
    expect(readRecentBoardConnectSurface()).toBe('picker_scan_again');
    vi.setSystemTime(1_000_000 + BOARD_CONNECT_ENTRY_WINDOW_MS);
    expect(readRecentBoardConnectSurface()).toBe('picker_scan_again');
    vi.setSystemTime(1_000_000 + BOARD_CONNECT_ENTRY_WINDOW_MS + 1);
    expect(readRecentBoardConnectSurface()).toBeNull();
  });
});
