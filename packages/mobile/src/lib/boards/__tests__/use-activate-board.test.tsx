// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

const setActiveBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const adoptFoundBoardMock = vi.hoisted(() => vi.fn());
const dismissToMock = vi.hoisted(() => vi.fn());
const showToastMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const markOnboardingSeenMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const setBoardRevealTipPendingMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const reportErrorMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({ useRouter: () => ({ dismissTo: dismissToMock }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../graphql/use-active-board', () => ({ useSetActiveBoard: () => setActiveBoardMock }));
vi.mock('../../board-discovery/use-adopt-found-board', () => ({ useAdoptFoundBoard: () => adoptFoundBoardMock }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: showToastMock }) }));
vi.mock('../../haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../analytics', () => ({ track: trackMock }));
vi.mock('../../onboarding/onboarding-storage', () => ({
  markOnboardingSeen: markOnboardingSeenMock,
  setBoardRevealTipPending: setBoardRevealTipPendingMock,
}));
vi.mock('../../error-reporting', () => ({ reportError: reportErrorMock }));

import { useActivateBoard, type ActivateBoardOptions } from '../use-activate-board';

const BOARD = { uuid: 'board-1', name: 'Klimmuur', boardType: 'kilter' } as unknown as UserBoard;

function activate(options: Partial<ActivateBoardOptions> = {}) {
  const { result } = renderHook(() => useActivateBoard({ returnTo: '/(tabs)/climbs', ...options }));
  return result;
}

describe('useActivateBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActiveBoardMock.mockResolvedValue(undefined);
    markOnboardingSeenMock.mockResolvedValue(undefined);
    setBoardRevealTipPendingMock.mockResolvedValue(undefined);
  });

  it('persists the board, then navigates, then adopts', async () => {
    const result = activate();
    await result.current(BOARD);

    expect(setActiveBoardMock).toHaveBeenCalledWith(BOARD);
    expect(dismissToMock).toHaveBeenCalledWith('/(tabs)/climbs');
    expect(adoptFoundBoardMock).toHaveBeenCalledWith(BOARD);
  });

  // A board that won't survive the next cold start is worse than no board, so a
  // failed write must not be followed by a navigation that implies success.
  it('does not navigate when the write fails', async () => {
    setActiveBoardMock.mockRejectedValue(new Error('storage full'));
    const result = activate();
    await result.current(BOARD);

    expect(dismissToMock).not.toHaveBeenCalled();
    expect(adoptFoundBoardMock).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith('mobile.boardSwitchError', 'error');
  });

  it('skips adoption when the rows came from the on-device snapshots', async () => {
    const result = activate({ isLocalOnly: true });
    await result.current(BOARD);

    expect(dismissToMock).toHaveBeenCalled();
    expect(adoptFoundBoardMock).not.toHaveBeenCalled();
  });

  describe('an ordinary board switch', () => {
    it('fires no onboarding side effects', async () => {
      const result = activate();
      await result.current(BOARD);

      expect(trackMock).not.toHaveBeenCalled();
      expect(setBoardRevealTipPendingMock).not.toHaveBeenCalled();
      expect(markOnboardingSeenMock).not.toHaveBeenCalled();
    });
  });

  describe('the onboarding bind', () => {
    it('tracks the activation, arms the reveal banner and closes out first-run', async () => {
      const result = activate({ source: 'onboarding' });
      await result.current(BOARD);

      expect(trackMock).toHaveBeenCalledWith('Onboarding Board Activated', {
        boardType: 'kilter',
        source: 'onboarding',
      });
      expect(setBoardRevealTipPendingMock).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(markOnboardingSeenMock).toHaveBeenCalledTimes(1));
    });

    // The gate shows onboarding whenever there is no board, so a keychain that
    // refuses the write would loop the climber back through a flow they finished.
    // It still must not block the bind — report and carry on.
    it('navigates even when the seen flag cannot be written', async () => {
      markOnboardingSeenMock.mockRejectedValue(new Error('keychain locked'));
      const result = activate({ source: 'onboarding' });
      await result.current(BOARD);

      expect(dismissToMock).toHaveBeenCalled();
      await waitFor(() => expect(reportErrorMock).toHaveBeenCalled());
    });
  });

  describe('onBound', () => {
    it('runs after the bind and before the navigation', async () => {
      const order: string[] = [];
      setActiveBoardMock.mockImplementation(async () => void order.push('bind'));
      dismissToMock.mockImplementation(() => void order.push('navigate'));
      const result = activate({ onBound: async () => void order.push('onBound') });

      await result.current(BOARD);

      expect(order).toEqual(['bind', 'onBound', 'navigate']);
    });

    // The board IS bound by this point. Refusing to navigate over a failed extra
    // would strand the climber on a step they have already completed.
    it('still navigates when it throws', async () => {
      const result = activate({
        onBound: () => Promise.reject(new Error('dialog blew up')),
      });

      await result.current(BOARD);

      expect(dismissToMock).toHaveBeenCalled();
      expect(reportErrorMock).toHaveBeenCalled();
      expect(showToastMock).not.toHaveBeenCalled();
    });
  });

  it('uses the injected navigate when one is given', async () => {
    const navigate = vi.fn();
    const result = activate({ navigate });
    await result.current(BOARD);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(dismissToMock).not.toHaveBeenCalled();
  });
});
