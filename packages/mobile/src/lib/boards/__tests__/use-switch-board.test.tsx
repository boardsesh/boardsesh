// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

const setActiveBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const adoptFoundBoardMock = vi.hoisted(() => vi.fn());
const resolveBoardAngleMock = vi.hoisted(() => vi.fn());
const hapticMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const reportErrorMock = vi.hoisted(() => vi.fn());
const showToastMock = vi.hoisted(() => vi.fn());

vi.mock('../../graphql/use-active-board', () => ({ useSetActiveBoard: () => setActiveBoardMock }));
vi.mock('../../board-discovery/use-adopt-found-board', () => ({ useAdoptFoundBoard: () => adoptFoundBoardMock }));
vi.mock('../board-angle-store', () => ({ resolveBoardAngle: resolveBoardAngleMock }));
vi.mock('../../haptics', () => ({ hapticSelection: hapticMock }));
vi.mock('../../analytics', () => ({ track: trackMock }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: showToastMock }) }));
vi.mock('../../error-reporting', () => ({ reportError: reportErrorMock }));

import { useSwitchBoard, type SwitchBoardOptions } from '../use-switch-board';

const KILTER = {
  uuid: 'kilter-1',
  name: 'Pump Station - Kilter',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 40,
  gymUuid: 'gym-1',
} as unknown as UserBoard;

const TENSION = {
  uuid: 'tension-1',
  name: 'Pump Station - Tension',
  boardType: 'tension',
  layoutId: 8,
  sizeId: 3,
  setIds: '5,6',
  angle: 25,
  gymUuid: 'gym-1',
} as unknown as UserBoard;

function switcher(options: Partial<SwitchBoardOptions> = {}) {
  const { result } = renderHook(() => useSwitchBoard({ source: 'presence_sheet_sibling', ...options }));
  return result;
}

describe('useSwitchBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActiveBoardMock.mockResolvedValue(undefined);
    resolveBoardAngleMock.mockImplementation((board: UserBoard) => Promise.resolve(board.angle));
  });

  it('persists the target, then notifies, broadcasts and adopts', async () => {
    const onSwitched = vi.fn();
    const broadcastBoardPath = vi.fn();
    const result = switcher({ onSwitched, broadcastBoardPath });

    const outcome = await result.current(TENSION, KILTER);

    expect(outcome).toBe('switched');
    expect(setActiveBoardMock).toHaveBeenCalledWith({ ...TENSION, angle: 25 });
    expect(onSwitched).toHaveBeenCalledWith(TENSION);
    expect(broadcastBoardPath).toHaveBeenCalledWith({ ...TENSION, angle: 25 });
    expect(adoptFoundBoardMock).toHaveBeenCalledWith({ ...TENSION, angle: 25 });
  });

  // A "switch" to the wall you are already on must not report success, or the
  // prompt that sent the climber here clears as though something happened.
  it('is a no-op when the target is already the active board', async () => {
    const result = switcher();

    const outcome = await result.current(KILTER, KILTER);

    expect(outcome).toBe('noop');
    expect(setActiveBoardMock).not.toHaveBeenCalled();
    expect(adoptFoundBoardMock).not.toHaveBeenCalled();
  });

  // The angle belongs to the wall being adopted. Carrying the current board's
  // angle across is how a climber ends up "on" a fixed wall at 40 degrees.
  it('adopts the target wall angle, never the angle of the board being left', async () => {
    resolveBoardAngleMock.mockResolvedValue(25);
    const result = switcher();

    await result.current(TENSION, KILTER);

    expect(resolveBoardAngleMock).toHaveBeenCalledWith(TENSION);
    expect(setActiveBoardMock).toHaveBeenCalledWith(expect.objectContaining({ angle: 25 }));
  });

  it('leaves the climber on the old board when the write fails', async () => {
    setActiveBoardMock.mockRejectedValue(new Error('storage full'));
    const onSwitched = vi.fn();
    const broadcastBoardPath = vi.fn();
    const result = switcher({ onSwitched, broadcastBoardPath });

    const outcome = await result.current(TENSION, KILTER);

    expect(outcome).toBe('failed');
    expect(onSwitched).not.toHaveBeenCalled();
    expect(broadcastBoardPath).not.toHaveBeenCalled();
    expect(adoptFoundBoardMock).not.toHaveBeenCalled();
    expect(trackMock).toHaveBeenCalledWith('Board Swap Failed', expect.objectContaining({ reason: 'write_failed' }));
  });

  it('skips adoption when the board list came from on-device data', async () => {
    const result = switcher({ isLocalOnly: true });

    await result.current(TENSION, KILTER);

    expect(setActiveBoardMock).toHaveBeenCalled();
    expect(adoptFoundBoardMock).not.toHaveBeenCalled();
  });

  it('reports the hop as same-gym and different-config', async () => {
    const result = switcher({ queueSize: 6, inSession: true, hasBleLink: true });

    await result.current(TENSION, KILTER);

    expect(trackMock).toHaveBeenCalledWith(
      'Board Swap Completed',
      expect.objectContaining({
        source: 'presence_sheet_sibling',
        toBoardUuid: 'tension-1',
        sameGym: true,
        sameConfig: false,
        queueSize: 6,
        inSession: true,
        hadBleLink: true,
      }),
    );
  });

  it('reports a hop between two identically configured walls as sameConfig', async () => {
    const twin = { ...KILTER, uuid: 'kilter-2', name: 'Pump Station - Kilter' } as unknown as UserBoard;
    const result = switcher();

    await result.current(twin, KILTER);

    expect(trackMock).toHaveBeenCalledWith('Board Swap Completed', expect.objectContaining({ sameConfig: true }));
  });

  it('switches with no previous board bound', async () => {
    const result = switcher();

    const outcome = await result.current(TENSION, null);

    expect(outcome).toBe('switched');
    expect(trackMock).toHaveBeenCalledWith('Board Swap Completed', expect.objectContaining({ sameGym: false }));
  });
});
