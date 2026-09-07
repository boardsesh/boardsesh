// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { OnboardingBoardStepProps } from '../OnboardingBoardStep';

const stepCtrl = vi.hoisted(() => ({ props: null as OnboardingBoardStepProps | null }));
const boardsCtrl = vi.hoisted(() => ({
  boards: [] as UserBoard[],
  isLoading: false,
  isError: false,
}));
const envCtrl = vi.hoisted(() => ({
  isOffline: false,
  offlineDownloadsEnabled: true,
  offlineState: 'off' as string,
  // Link-step inputs. Default off, so every pre-existing test still asserts the
  // unchanged hand-off straight to Climbs.
  linkStepEnabled: false as boolean,
  linkStepAnswered: false as boolean,
  credentials: [] as { boardType: string }[] | undefined,
}));

const replaceMock = vi.hoisted(() => vi.fn());
const pushMock = vi.hoisted(() => vi.fn());
const confirmAndDownloadMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const activateBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const activateOptionsCtrl = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
const nudgeMocks = vi.hoisted(() => ({
  trackNudgeShown: vi.fn(),
  trackNudgeAccepted: vi.fn(),
  trackNudgeDismissed: vi.fn(),
}));

vi.mock('expo-router', () => ({ router: { replace: replaceMock, push: pushMock } }));
vi.mock('../OnboardingBoardStep', () => ({
  OnboardingBoardStep: (props: OnboardingBoardStepProps) => {
    stepCtrl.props = props;
    return null;
  },
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useMyBoards: () => ({
    data: { boards: boardsCtrl.boards },
    isLoading: boardsCtrl.isLoading,
    isError: boardsCtrl.isError,
  }),
  useProfile: () => ({ data: { id: 'user-a' } }),
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../hooks/use-is-offline', () => ({ useIsOffline: () => envCtrl.isOffline }));
vi.mock('../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: undefined, isLoading: false }),
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useOfflineDownloadsEnabled: () => envCtrl.offlineDownloadsEnabled,
  useFeatureFlag: (key: string) => (key === 'board-link-onboarding-step' ? envCtrl.linkStepEnabled : undefined),
}));
// Both reach real native modules (AsyncStorage, expo-web-browser) through their
// implementations, so they are mocked at the seam like every other IO here.
vi.mock('../../../lib/onboarding/link-step-answered', () => ({
  hasAnsweredLinkStep: () => Promise.resolve(envCtrl.linkStepAnswered),
}));
vi.mock('../../../lib/integrations/use-board-account-credentials', () => ({
  useBoardAccountCredentials: () => ({ data: envCtrl.credentials }),
}));
vi.mock('../../../offline/use-confirm-board-download', () => ({
  useConfirmBoardDownload: () => ({ confirmAndDownload: confirmAndDownloadMock }),
}));
vi.mock('../../../offline/use-downloaded-scope-keys', () => ({
  useDownloadedScopeKeys: () => ({ data: ['kilter:9:99'] }),
}));
vi.mock('../../board-discovery/use-board-offline-state', () => ({
  useBoardOfflineState: () => () => envCtrl.offlineState,
}));
vi.mock('../../../lib/offline-nudges/nudge-analytics', () => nudgeMocks);
vi.mock('../../../settings', () => ({
  offlineBoardKeyForBoard: (board: UserBoard) => `${board.boardType}:${board.layoutId}:${board.sizeId}`,
}));
vi.mock('../../../lib/boards/use-activate-board', () => ({
  useActivateBoard: (options: Record<string, unknown>) => {
    activateOptionsCtrl.last = options;
    return activateBoardMock;
  },
}));

import { OnboardingBoardRoute } from '../OnboardingBoardRoute';

const BOARD = {
  uuid: 'board-1',
  name: 'Klimmuur',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '20,1',
} as unknown as UserBoard;

const NUDGE_CONTEXT = {
  boardType: 'kilter',
  layoutId: 1,
  scopeKey: 'kilter:1:10',
  downloadedBoardCount: 1,
};

function renderRoute() {
  return render(<OnboardingBoardRoute accentColor="#6D28D9" bodyColor="#888" backgroundColor="#fff" />);
}

/** Run the `onBound` hook the route hands to `useActivateBoard`. */
async function runOnBound(board: UserBoard = BOARD) {
  const onBound = activateOptionsCtrl.last?.onBound as ((value: UserBoard) => Promise<void>) | undefined;
  await onBound?.(board);
}

describe('OnboardingBoardRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmAndDownloadMock.mockResolvedValue(true);
    boardsCtrl.boards = [BOARD];
    boardsCtrl.isLoading = false;
    boardsCtrl.isError = false;
    envCtrl.isOffline = false;
    envCtrl.offlineDownloadsEnabled = true;
    envCtrl.offlineState = 'off';
    envCtrl.linkStepEnabled = false;
    envCtrl.linkStepAnswered = false;
    envCtrl.credentials = [];
    stepCtrl.props = null;
    activateOptionsCtrl.last = null;
    cleanup();
  });

  it('binds as the onboarding activation, and leaves to Climbs rather than dismissing', () => {
    renderRoute();

    expect(activateOptionsCtrl.last?.source).toBe('onboarding');
    (activateOptionsCtrl.last?.navigate as () => void)();
    expect(replaceMock).toHaveBeenCalledWith('/(tabs)/climbs');
  });

  // The link card sits between the board pick and Climbs. It goes BEFORE the
  // board-look step because `app/onboarding.tsx` forbids chaining past
  // `BoardLookStepGate`, and because board-look may never run at all.
  describe('the board-account link hand-off', () => {
    /** Pick a board (which captures it) then run the post-bind navigation. */
    const bindAndLeave = async (board: UserBoard = BOARD) => {
      stepCtrl.props?.onSelect(board);
      await waitFor(() => expect(activateOptionsCtrl.last?.navigate).toBeTypeOf('function'));
      (activateOptionsCtrl.last?.navigate as () => void)();
    };

    it('goes straight to Climbs while the flag is off, exactly as before', async () => {
      renderRoute();
      await bindAndLeave();
      expect(replaceMock).toHaveBeenCalledWith('/(tabs)/climbs');
    });

    it('offers the link card for the board that was just bound', async () => {
      envCtrl.linkStepEnabled = true;
      renderRoute();
      await waitFor(() => expect(stepCtrl.props).not.toBeNull());
      await bindAndLeave();
      await waitFor(() =>
        expect(replaceMock).toHaveBeenCalledWith({
          pathname: '/onboarding',
          params: { step: 'link', boardType: 'kilter' },
        }),
      );
    });

    it('skips the card for a climber who already linked an account', async () => {
      envCtrl.linkStepEnabled = true;
      envCtrl.credentials = [{ boardType: 'kilter' }];
      renderRoute();
      await waitFor(() => expect(stepCtrl.props).not.toBeNull());
      await bindAndLeave();
      expect(replaceMock).toHaveBeenCalledWith('/(tabs)/climbs');
    });

    // MoonBoard has no credential flow — its only route in is a CSV obtained by
    // emailing Moon Climbing a GDPR request.
    it('skips the card for MoonBoard, which cannot be linked', async () => {
      envCtrl.linkStepEnabled = true;
      renderRoute();
      await waitFor(() => expect(stepCtrl.props).not.toBeNull());
      await bindAndLeave({ ...BOARD, boardType: 'moonboard' } as unknown as UserBoard);
      expect(replaceMock).toHaveBeenCalledWith('/(tabs)/climbs');
    });

    it('skips the card offline, where the form could not submit anyway', async () => {
      envCtrl.linkStepEnabled = true;
      envCtrl.isOffline = true;
      renderRoute();
      await waitFor(() => expect(stepCtrl.props).not.toBeNull());
      await bindAndLeave();
      expect(replaceMock).toHaveBeenCalledWith('/(tabs)/climbs');
    });
  });

  describe('the download offer', () => {
    it('quotes the size and records the whole funnel when accepted', async () => {
      renderRoute();
      await runOnBound();

      expect(nudgeMocks.trackNudgeShown).toHaveBeenCalledWith({ surface: 'onboarding', ...NUDGE_CONTEXT });
      expect(confirmAndDownloadMock).toHaveBeenCalledWith(BOARD, {
        trigger: 'onboarding',
        source: 'onboarding',
      });
      expect(nudgeMocks.trackNudgeAccepted).toHaveBeenCalledWith(
        { surface: 'onboarding', ...NUDGE_CONTEXT },
        'download',
      );
      expect(nudgeMocks.trackNudgeDismissed).not.toHaveBeenCalled();
    });

    it('records a decline, so the take rate is readable', async () => {
      confirmAndDownloadMock.mockResolvedValue(false);
      renderRoute();
      await runOnBound();

      expect(nudgeMocks.trackNudgeDismissed).toHaveBeenCalledWith({ surface: 'onboarding', ...NUDGE_CONTEXT }, 'once');
      expect(nudgeMocks.trackNudgeAccepted).not.toHaveBeenCalled();
    });

    // Quoting a download the climber has already asked for is noise, and the
    // dialog would have nothing to offer.
    it('stays quiet for a board already on the phone or on its way', async () => {
      envCtrl.offlineState = 'downloaded';
      renderRoute();
      await runOnBound();

      expect(confirmAndDownloadMock).not.toHaveBeenCalled();
      expect(nudgeMocks.trackNudgeShown).not.toHaveBeenCalled();
    });

    // Arming something invisible that lands "sometime after you reconnect" is
    // not a promise worth making on a first-run screen without asking.
    it('stays quiet with no connection', async () => {
      envCtrl.isOffline = true;
      renderRoute();
      await runOnBound();

      expect(confirmAndDownloadMock).not.toHaveBeenCalled();
    });

    it('stays quiet where the engine cannot run', async () => {
      envCtrl.offlineDownloadsEnabled = false;
      renderRoute();
      await runOnBound();

      expect(confirmAndDownloadMock).not.toHaveBeenCalled();
    });
  });

  // The glyph is the same affordance as the one on /boards, which is accept-only
  // there. Filing it under `onboarding` would mix an impression-tracked offer
  // with an untracked one and wreck that surface's shown-to-accepted rate.
  it('reports the card glyph as the board_card surface, accept-only', async () => {
    renderRoute();
    stepCtrl.props?.onDownload(BOARD);

    await waitFor(() =>
      expect(nudgeMocks.trackNudgeAccepted).toHaveBeenCalledWith(
        { surface: 'board_card', ...NUDGE_CONTEXT },
        'download',
      ),
    );
    expect(nudgeMocks.trackNudgeShown).not.toHaveBeenCalled();
  });

  it('hands off to the full picker tagged as the onboarding flow', () => {
    renderRoute();
    stepCtrl.props?.onFindBoard();

    expect(pushMock).toHaveBeenCalledWith({ pathname: '/boards', params: { source: 'onboarding' } });
  });

  describe('the escape hatch', () => {
    it('is withheld while there is any board to choose from', () => {
      envCtrl.isOffline = true;
      renderRoute();
      expect(stepCtrl.props?.onSkipUnusable).toBeNull();
    });

    it('is withheld while the list is still loading', () => {
      boardsCtrl.boards = [];
      boardsCtrl.isLoading = true;
      envCtrl.isOffline = true;
      renderRoute();
      expect(stepCtrl.props?.onSkipUnusable).toBeNull();
    });

    it('is withheld when the list simply came back empty online', () => {
      boardsCtrl.boards = [];
      renderRoute();
      // A climber with no boards and a working connection is not stuck — the
      // full picker can still find or build one for them.
      expect(stepCtrl.props?.onSkipUnusable).toBeNull();
    });

    it('opens when there is no connection and nothing cached', () => {
      boardsCtrl.boards = [];
      envCtrl.isOffline = true;
      renderRoute();

      stepCtrl.props?.onSkipUnusable?.();
      expect(replaceMock).toHaveBeenCalledWith('/(tabs)/climbs');
    });

    // Captive-portal or gym wifi with a dead upstream reports ONLINE while every
    // request fails, so `isOffline` alone would leave that climber stuck.
    it('opens on a lying connection too', () => {
      boardsCtrl.boards = [];
      boardsCtrl.isError = true;
      envCtrl.isOffline = false;
      renderRoute();

      expect(stepCtrl.props?.onSkipUnusable).not.toBeNull();
    });
  });
});
