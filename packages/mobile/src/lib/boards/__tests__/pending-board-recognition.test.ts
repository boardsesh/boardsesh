import { beforeEach, describe, expect, it, vi } from 'vitest';

// The box the climber set off from, held until they bind its board on any route.

const recognition = vi.hoisted(() => ({ remember: vi.fn(async () => {}) }));
vi.mock('../../ble/recognized-board-devices-store', () => ({
  rememberRecognizedBoardDevice: recognition.remember,
}));

import {
  clearPendingBoardRecognition,
  consumePendingBoardRecognition,
  PENDING_BOARD_RECOGNITION_TTL_MS,
  pendingRecognitionOutcome,
  readPendingBoardRecognition,
  setPendingBoardRecognition,
  type PendingBoardRecognition,
} from '../pending-board-recognition';

const SET_AT_MS = 1_000_000;
const HELD_MOONBOARD: PendingBoardRecognition = {
  deviceId: 'MOON-BOX',
  boardType: 'moonboard',
  expiresAt: SET_AT_MS + PENDING_BOARD_RECOGNITION_TTL_MS,
};

beforeEach(() => {
  clearPendingBoardRecognition();
  recognition.remember.mockClear();
});

describe('pendingRecognitionOutcome', () => {
  it.each([
    { name: 'nothing held', pending: null, boardType: 'moonboard', nowMs: SET_AT_MS, expected: 'nothing_pending' },
    {
      name: 'same type, just set',
      pending: HELD_MOONBOARD,
      boardType: 'moonboard',
      nowMs: SET_AT_MS,
      expected: 'remember',
    },
    {
      name: 'same type, a second before expiry',
      pending: HELD_MOONBOARD,
      boardType: 'moonboard',
      nowMs: HELD_MOONBOARD.expiresAt - 1000,
      expected: 'remember',
    },
    {
      name: 'same type, at expiry',
      pending: HELD_MOONBOARD,
      boardType: 'moonboard',
      nowMs: HELD_MOONBOARD.expiresAt,
      expected: 'expired',
    },
    { name: 'another type', pending: HELD_MOONBOARD, boardType: 'kilter', nowMs: SET_AT_MS, expected: 'other_type' },
    {
      name: 'another type after expiry',
      pending: HELD_MOONBOARD,
      boardType: 'kilter',
      nowMs: HELD_MOONBOARD.expiresAt + 1,
      expected: 'expired',
    },
    { name: 'a spray wall', pending: HELD_MOONBOARD, boardType: 'spray', nowMs: SET_AT_MS, expected: 'other_type' },
    {
      name: 'a type this build does not know',
      pending: HELD_MOONBOARD,
      boardType: 'not-a-board',
      nowMs: SET_AT_MS,
      expected: 'other_type',
    },
  ])('$name → $expected', ({ pending, boardType, nowMs, expected }) => {
    expect(pendingRecognitionOutcome(pending, boardType, nowMs)).toBe(expected);
  });
});

describe('consumePendingBoardRecognition', () => {
  it('binds the held box to a board of its type and lets go of it', async () => {
    setPendingBoardRecognition({ deviceId: 'MOON-BOX', boardType: 'moonboard' }, SET_AT_MS);
    const board = { uuid: 'gym-moon', boardType: 'moonboard' };

    await consumePendingBoardRecognition(board, SET_AT_MS + 60_000);

    expect(recognition.remember).toHaveBeenCalledExactlyOnceWith('MOON-BOX', board);
    expect(readPendingBoardRecognition()).toBeNull();
  });

  it('keeps waiting through a bind of another board type', async () => {
    setPendingBoardRecognition({ deviceId: 'MOON-BOX', boardType: 'moonboard' }, SET_AT_MS);

    await consumePendingBoardRecognition({ uuid: 'gym-kilter', boardType: 'kilter' }, SET_AT_MS + 60_000);

    expect(recognition.remember).not.toHaveBeenCalled();
    expect(readPendingBoardRecognition()).toEqual(HELD_MOONBOARD);
  });

  it('drops a hold ten minutes old without binding anything', async () => {
    setPendingBoardRecognition({ deviceId: 'MOON-BOX', boardType: 'moonboard' }, SET_AT_MS);

    await consumePendingBoardRecognition(
      { uuid: 'gym-moon', boardType: 'moonboard' },
      SET_AT_MS + PENDING_BOARD_RECOGNITION_TTL_MS,
    );

    expect(recognition.remember).not.toHaveBeenCalled();
    expect(readPendingBoardRecognition()).toBeNull();
  });

  it('does nothing with nothing held', async () => {
    await consumePendingBoardRecognition({ uuid: 'gym-moon', boardType: 'moonboard' }, SET_AT_MS);
    expect(recognition.remember).not.toHaveBeenCalled();
  });

  it('takes the latest box the climber acted on', async () => {
    setPendingBoardRecognition({ deviceId: 'FIRST-BOX', boardType: 'moonboard' }, SET_AT_MS);
    setPendingBoardRecognition({ deviceId: 'SECOND-BOX', boardType: 'kilter' }, SET_AT_MS + 1000);

    await consumePendingBoardRecognition({ uuid: 'home-kilter', boardType: 'kilter' }, SET_AT_MS + 2000);

    expect(recognition.remember).toHaveBeenCalledExactlyOnceWith('SECOND-BOX', {
      uuid: 'home-kilter',
      boardType: 'kilter',
    });
  });

  it('is cleared by clearPendingBoardRecognition', async () => {
    setPendingBoardRecognition({ deviceId: 'MOON-BOX', boardType: 'moonboard' }, SET_AT_MS);
    clearPendingBoardRecognition();

    await consumePendingBoardRecognition({ uuid: 'gym-moon', boardType: 'moonboard' }, SET_AT_MS);

    expect(recognition.remember).not.toHaveBeenCalled();
  });
});
