import { describe, expect, it } from 'vitest';
import type { BoardConnectionHolder } from '@boardsesh/shared-schema';
import { deriveLiveActivityBoardPresence } from '../live-activity-board-relay';

function holderOf(overrides: Partial<BoardConnectionHolder> = {}): BoardConnectionHolder {
  return {
    userId: 'sam',
    displayName: 'Sam',
    avatarUrl: null,
    lastSentAt: new Date().toISOString(),
    ...overrides,
  } as BoardConnectionHolder;
}

describe('deriveLiveActivityBoardPresence (#7220)', () => {
  it('leaves this phone’s own link alone, whatever presence says', () => {
    expect(
      deriveLiveActivityBoardPresence({
        boardConnection: 'connectedByMe',
        holderDisplayName: null,
        relayHolder: holderOf(),
        blockingHolder: holderOf(),
      }),
    ).toEqual({ boardConnection: 'connectedByMe', holderDisplayName: null, boardRelay: null });
  });

  it('reads a relaying phone as held, with the holder named and `relaying` beside it', () => {
    expect(
      deriveLiveActivityBoardPresence({
        boardConnection: 'disconnected',
        holderDisplayName: null,
        relayHolder: holderOf(),
        blockingHolder: holderOf(),
      }),
    ).toEqual({ boardConnection: 'heldByPeer', holderDisplayName: 'Sam', boardRelay: 'relaying' });
  });

  it('names no one for an anonymous holder', () => {
    const anonymous = holderOf({ userId: null, displayName: null });
    expect(
      deriveLiveActivityBoardPresence({
        boardConnection: 'disconnected',
        holderDisplayName: null,
        relayHolder: anonymous,
        blockingHolder: anonymous,
      }),
    ).toEqual({ boardConnection: 'heldByPeer', holderDisplayName: null, boardRelay: 'relaying' });
  });

  it('turns a stranger’s hold that blocks a connect from disconnected into held', () => {
    expect(
      deriveLiveActivityBoardPresence({
        boardConnection: 'disconnected',
        holderDisplayName: null,
        relayHolder: null,
        blockingHolder: holderOf(),
      }),
    ).toEqual({ boardConnection: 'heldByPeer', holderDisplayName: 'Sam', boardRelay: 'blocked' });
  });

  it('keeps a crewmate’s name already on the card when their hold blocks a connect', () => {
    expect(
      deriveLiveActivityBoardPresence({
        boardConnection: 'heldByPeer',
        holderDisplayName: 'Kim',
        relayHolder: null,
        blockingHolder: holderOf({ userId: 'kim', displayName: 'Kim' }),
      }),
    ).toEqual({ boardConnection: 'heldByPeer', holderDisplayName: 'Kim', boardRelay: 'blocked' });
  });

  it('is today’s value with no relay holder (flag off, Several phones, another board)', () => {
    for (const boardConnection of ['heldByPeer', 'disconnected'] as const) {
      expect(
        deriveLiveActivityBoardPresence({
          boardConnection,
          holderDisplayName: boardConnection === 'heldByPeer' ? 'Kim' : null,
          relayHolder: null,
          blockingHolder: null,
        }),
      ).toEqual({
        boardConnection,
        holderDisplayName: boardConnection === 'heldByPeer' ? 'Kim' : null,
        boardRelay: null,
      });
    }
  });

  it('only ever sends one of the three connection values every binary knows', () => {
    const holders = [null, holderOf()];
    for (const boardConnection of ['connectedByMe', 'heldByPeer', 'disconnected'] as const) {
      for (const relayHolder of holders) {
        for (const blockingHolder of holders) {
          const presence = deriveLiveActivityBoardPresence({
            boardConnection,
            holderDisplayName: null,
            relayHolder,
            blockingHolder,
          });
          expect(['connectedByMe', 'heldByPeer', 'disconnected']).toContain(presence.boardConnection);
          // A relay never travels with a value an older binary would draw as "Tap to reconnect".
          if (presence.boardRelay !== null) expect(presence.boardConnection).toBe('heldByPeer');
        }
      }
    }
  });
});
