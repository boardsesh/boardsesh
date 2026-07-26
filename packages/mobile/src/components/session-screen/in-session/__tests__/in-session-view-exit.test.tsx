// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// #3502 — leave-vs-end. InSessionView + the REAL useSessionExitOptions hook,
// with only the hook's inputs stubbed (roster, owner query, device provenance),
// so deleting the gate inside that hook fails these tests rather than passing a
// re-implementation of itself.
//
// The three scenarios that matter:
//   1. the phone that STARTED the session      → leads with End (unchanged)
//   2. the same climber's SECOND phone         → leads with Leave, End still reachable
//   3. someone else's session (known foreign)  → Leave only, End withheld

const queue = vi.hoisted(() => ({
  endSession: vi.fn(),
  clearSession: vi.fn(),
}));
const sheet = vi.hoisted(() => ({
  defaultMode: null as string | null,
  canEnd: null as boolean | null,
  onConfirm: null as (() => void) | null,
  onLeave: null as (() => void) | null,
}));
const chrome = vi.hoisted(() => ({ exitVariant: null as string | null }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const integrations = vi.hoisted(() => ({ runSessionEndExports: vi.fn() }));

// The hook's three inputs.
const session = vi.hoisted(() => ({
  // Roster row for participant-1. `id` is the participant id (a user UUID for
  // signed-in climbers), `userId` the DB user id — matched on `id`, never
  // `clientId`, because those are different id-spaces.
  users: [{ id: 'participant-1', username: 'Marco', isLeader: true, userId: 'user-me', connectionState: 'CONNECTED' }],
  ownerUserId: 'user-me' as string | null,
  createdSessionId: 'session-1' as string | null,
}));

vi.mock('react-native', () => ({
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-native-gesture-handler', () => ({
  Gesture: {
    Pan: () => ({
      activeOffsetY: () => ({ onStart: () => ({ onUpdate: () => ({ onEnd: () => ({}) }) }) }),
    }),
  },
  GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-native-reanimated', () => ({
  useSharedValue: (value: number) => ({ value }),
  withSpring: (value: number) => value,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    ListHeaderComponent,
    ListFooterComponent,
  }: {
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => createElement('div', null, ListHeaderComponent, ListFooterComponent),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@boardsesh/play-view', () => ({ formatGrade: (grade: string) => grade, getGradeTextColor: () => '#fff' }));
vi.mock('@boardsesh/analytics', () => ({ SHARED_EVENTS: { SessionLeft: 'Session Left' } }));

vi.mock('../../../Button', () => ({ Button: () => createElement('button') }));
vi.mock('../../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../GlassSurface', () => ({ GlassSurface: () => null }));
vi.mock('../../../ListRow', () => ({ ListRow: () => null }));
vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../SectionHeader', () => ({ SectionHeader: () => null }));
vi.mock('../../../ScreenTitle', () => ({ ScreenTitle: () => null }));
vi.mock('../../../ClimbListItemContent', () => ({ ClimbListItemContent: () => null }));
vi.mock('../../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../SessionTitleSheet', () => ({ SessionTitleSheet: () => null }));

// Capture what the chrome is told the exit does — a red Stop that only leaves
// is the lie this issue is partly about.
vi.mock('../../RecordTopChrome', () => ({
  RecordTopChrome: ({ exitVariant }: { exitVariant?: string }) => {
    chrome.exitVariant = exitVariant ?? null;
    return null;
  },
}));

vi.mock('../../../EndSessionSheet', () => ({
  EndSessionSheet: ({
    defaultMode,
    canEnd,
    onConfirm,
    onLeave,
  }: {
    defaultMode?: string;
    canEnd?: boolean;
    onConfirm?: () => void;
    onLeave?: () => void;
  }) => {
    sheet.defaultMode = defaultMode ?? null;
    sheet.canEnd = canEnd ?? null;
    sheet.onConfirm = onConfirm ?? null;
    sheet.onLeave = onLeave ?? null;
    return null;
  },
}));

vi.mock('../../../../lib/error-reporting', () => ({ reportError: vi.fn(), reportHandledError: vi.fn() }));
vi.mock('../../../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('../../../../providers/toast-provider', () => ({ useToast: () => toast }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: 'liquidGlass',
    systemColors: { background: '#000', secondaryBackground: '#111', secondaryLabel: '#999', separator: '#222' },
    brandColors: { success: '#0f0', warning: '#ff0', primary: '#00f', error: '#f00' },
    features: { inBodyLargeTitle: false },
  }),
}));
vi.mock('../../../../providers/queue-provider', () => ({
  useQueueActions: () => ({
    endSession: queue.endSession,
    clearSession: queue.clearSession,
    setCurrentClimb: vi.fn(),
  }),
  useQueueLiveStats: () => ({ liveStats: null, sessionUsers: session.users }),
  useQueueSessionControls: () => ({ participantId: 'participant-1', sessionId: 'session-1' }),
}));
vi.mock('../../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => ({ openPlayDrawer: vi.fn() }) }));
vi.mock('../../../../lib/graphql/hooks', () => ({
  useSessionDetail: () => ({
    data: { totalSends: 0, totalFlashes: 0, gradeDistribution: [], participants: [], hardestGrade: null, ticks: [] },
  }),
  useSessionSummary: () => ({ data: { startedAt: '2026-01-01T00:00:00.000Z' } }),
  useSessionPreview: () => ({ data: null }),
  useSessionOwnerUserId: () => ({ data: session.ownerUserId }),
}));
vi.mock('../../../../lib/session-store', () => ({
  getStoredCreatedSessionId: () => Promise.resolve(session.createdSessionId),
}));
vi.mock('../../../../lib/store-review', () => ({
  SESSION_STORE_REVIEW_CANDIDATE_PARAM: '1',
  isSessionStoreReviewEligible: () => false,
}));
vi.mock('../../../../lib/integrations', () => ({ runSessionEndExports: integrations.runSessionEndExports }));
vi.mock('../../../../lib/session-comment-draft-store', () => ({
  setDraftComment: vi.fn(),
  clearDraftComment: vi.fn(),
}));
vi.mock('../../../../lib/climb-to-queue-item', () => ({ climbToQueueItem: vi.fn() }));
vi.mock('../../../../lib/playlists/board-details-for-playlist', () => ({ getBoardConfigForPlaylist: () => null }));
vi.mock('../../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: vi.fn() }));
vi.mock('../../../../lib/tick-to-climb', () => ({ tickToClimb: () => null }));
vi.mock('../../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade: string | null) => grade, formatGradeByDifficultyId: () => null }),
}));
vi.mock('../../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({
    fixedFooterBottom: 88,
    jsQueueReserve: 0,
    tabBarBottom: 50,
    inSessionListBottom: 0,
  }),
}));
vi.mock('../../../../theme/colors', () => ({ withAlpha: (color: string) => color }));
vi.mock('../../../../theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#999' } }));
vi.mock('../../../../theme/animations', () => ({ springs: { gentle: {} } }));
vi.mock('../../../../theme/tokens', () => ({ borderRadius: { lg: 16 }, spacing: { 2: 8, 3: 12, 4: 16, 5: 20 } }));
vi.mock('../../../you/profile-chart-colors', () => ({ gradeBadgeColor: () => '#fff' }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn(), hapticMedium: vi.fn() }));
vi.mock('../../../../lib/formatTickRelativeTime', () => ({}));
vi.mock('../SessionAnalytics', () => ({ SessionAnalytics: () => null }));
vi.mock('../SessionLeaderboard', () => ({ SessionLeaderboard: () => null }));
vi.mock('../SessionPresenceRow', () => ({ SessionPresenceRow: () => null }));

import { InSessionView } from '../InSessionView';

async function renderInSession() {
  const result = render(createElement(InSessionView, { showChrome: true }));
  // The provenance read is async (SecureStore); wait for it to land before
  // asserting emphasis.
  await waitFor(() => expect(sheet.defaultMode).not.toBeNull());
  return result;
}

describe('InSessionView session exit (#3502)', () => {
  beforeEach(() => {
    queue.endSession.mockReset();
    queue.endSession.mockResolvedValue(null);
    queue.clearSession.mockReset();
    queue.clearSession.mockResolvedValue(undefined);
    router.push.mockClear();
    toast.showToast.mockClear();
    analytics.track.mockClear();
    integrations.runSessionEndExports.mockReset();
    sheet.defaultMode = null;
    sheet.canEnd = null;
    sheet.onConfirm = null;
    sheet.onLeave = null;
    chrome.exitVariant = null;
    session.users = [
      { id: 'participant-1', username: 'Marco', isLeader: true, userId: 'user-me', connectionState: 'CONNECTED' },
    ];
    session.ownerUserId = 'user-me';
    session.createdSessionId = 'session-1';
  });

  it('leads with End on the device that started the session', async () => {
    await renderInSession();
    expect(sheet.defaultMode).toBe('end');
    expect(sheet.canEnd).toBe(true);
    expect(chrome.exitVariant).toBe('end');
  });

  // Provenance is a SecureStore read, so it can't be known on the first frame.
  // Falling back to `end` there keeps that frame identical to the pre-#3502
  // chrome — a creator must never watch the control change identity under their
  // thumb. Collapse the fallback to `leadWithEnd = startedOnThisDevice` and this
  // fails (verified by mutation).
  it('renders the pre-existing End chrome on the first frame, before provenance resolves', () => {
    render(createElement(InSessionView, { showChrome: true }));
    expect(sheet.defaultMode).toBe('end');
    expect(chrome.exitVariant).toBe('end');
  });

  // ...but an unresolved read must not hand a known-foreign participant the
  // destructive mode. canEnd is computed independently of provenance.
  it('still withholds End on the first frame for a known-foreign participant', () => {
    session.ownerUserId = 'user-someone-else';
    render(createElement(InSessionView, { showChrome: true }));
    expect(sheet.canEnd).toBe(false);
  });

  // THE BUG. Same climber, same session, second phone: provenance is absent, so
  // the exit must lead with Leave. Delete the `startedOnThisDevice` term in
  // useSessionExitOptions and this flips back to 'end' — i.e. back to the only
  // exit being the one that kills the party for everyone.
  it("leads with Leave on the same climber's second phone, keeping End available", async () => {
    session.createdSessionId = null;
    await renderInSession();
    expect(sheet.defaultMode).toBe('leave');
    // Still the creator, so ending stays legal — just no longer the default.
    expect(sheet.canEnd).toBe(true);
    expect(chrome.exitVariant).toBe('leave');
  });

  // Delete the `isKnownForeign` gate and canEnd becomes true here, re-offering
  // an action the server refuses — the path that used to eject a joiner with a
  // generic "Action failed".
  it('withholds End entirely from a climber who joined someone else’s session', async () => {
    session.ownerUserId = 'user-someone-else';
    session.createdSessionId = null;
    await renderInSession();
    expect(sheet.defaultMode).toBe('leave');
    expect(sheet.canEnd).toBe(false);
    expect(chrome.exitVariant).toBe('leave');
  });

  // Permissive-on-unknown is deliberate: ownership is unresolved on first
  // render of every session, for anonymous sessions, and whenever the bundle
  // outruns the backend. Failing closed there would strand a creator with no
  // way to end their own session. Do not "harden" this.
  it('still offers End while ownership is unknown', async () => {
    session.ownerUserId = null;
    session.createdSessionId = null;
    await renderInSession();
    expect(sheet.canEnd).toBe(true);
    expect(sheet.defaultMode).toBe('leave');
  });

  it('does not treat a roster with no matching self row as foreign', async () => {
    // Roster raced our join: we can't resolve our own userId, so ownership is
    // unproven — permissive, same as above.
    session.users = [];
    session.ownerUserId = 'user-someone-else';
    await renderInSession();
    expect(sheet.canEnd).toBe(true);
  });

  describe('leaving', () => {
    it('emits LEAVE_SESSION rather than only tearing down locally', async () => {
      session.createdSessionId = null;
      await renderInSession();
      await act(async () => {
        sheet.onLeave?.();
      });
      // EXACT argument. A bare clearSession() leaves peers waiting out the 60s
      // disconnect grace before they see the departure — the whole reason
      // notifyServer exists.
      expect(queue.clearSession).toHaveBeenCalledWith({ notifyServer: true });
      expect(queue.endSession).not.toHaveBeenCalled();
    });

    it('shows no summary and runs no session-end exports', async () => {
      session.createdSessionId = null;
      await renderInSession();
      await act(async () => {
        sheet.onLeave?.();
      });
      expect(router.push).not.toHaveBeenCalled();
      expect(integrations.runSessionEndExports).not.toHaveBeenCalled();
      expect(toast.showToast).toHaveBeenCalledWith('mobile.toast.leftSession', 'success');
    });

    // Without a toast here the climber taps Leave, the spinner vanishes, and
    // nothing visibly happens — the sheet just sits there.
    it('surfaces a failed local teardown instead of failing silently', async () => {
      session.createdSessionId = null;
      queue.clearSession.mockRejectedValue(new Error('teardown exploded'));
      await renderInSession();
      await act(async () => {
        sheet.onLeave?.();
      });
      expect(toast.showToast).toHaveBeenCalledWith('mobile.queue.actionFailed', 'error');
      expect(toast.showToast).not.toHaveBeenCalledWith('mobile.toast.leftSession', 'success');
    });

    it('tracks the leave with the provenance split', async () => {
      session.createdSessionId = null;
      await renderInSession();
      await act(async () => {
        sheet.onLeave?.();
      });
      expect(analytics.track).toHaveBeenCalledWith('Session Left', {
        startedOnThisDevice: false,
        couldHaveEnded: true,
      });
    });
  });

  it('still ends (with summary + exports) when End is confirmed', async () => {
    queue.endSession.mockResolvedValue({ sessionId: 'session-1', totalSends: 1 });
    await renderInSession();
    await act(async () => {
      sheet.onConfirm?.();
    });
    expect(queue.endSession).toHaveBeenCalledTimes(1);
    expect(queue.clearSession).not.toHaveBeenCalled();
    expect(integrations.runSessionEndExports).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/(tabs)/record/summary' }));
  });
});
