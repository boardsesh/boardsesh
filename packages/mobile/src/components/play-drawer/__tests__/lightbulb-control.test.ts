import { describe, expect, it } from 'vitest';
import {
  deriveBoardConnection,
  deriveInAppBoardConnection,
  deriveLightbulbLit,
  derivePlayDrawerLightbulbPressAction,
} from '../lightbulb-control';
import type { BoardConnection } from '../lightbulb-control';

describe('play drawer lightbulb control', () => {
  it('derives the connect/disconnect tap action', () => {
    // No board selected on this client at all — nothing to toggle.
    expect(
      derivePlayDrawerLightbulbPressAction({
        hasBluetooth: false,
        isBluetoothConnected: false,
        isBluetoothLoading: false,
      }),
    ).toBe('noop');

    // A connect/disconnect already in flight — ignore the tap.
    expect(
      derivePlayDrawerLightbulbPressAction({
        hasBluetooth: true,
        isBluetoothConnected: false,
        isBluetoothLoading: true,
      }),
    ).toBe('noop');

    // Not connected → connect.
    expect(
      derivePlayDrawerLightbulbPressAction({
        hasBluetooth: true,
        isBluetoothConnected: false,
        isBluetoothLoading: false,
      }),
    ).toBe('connect');

    // Connected → disconnect.
    expect(
      derivePlayDrawerLightbulbPressAction({
        hasBluetooth: true,
        isBluetoothConnected: true,
        isBluetoothLoading: false,
      }),
    ).toBe('disconnect');
  });
});

describe('deriveLightbulbLit', () => {
  it('lights whenever this device holds the BLE link', () => {
    expect(
      deriveLightbulbLit({
        localConnected: true,
        isSubscribedToBoardFeed: false,
        sessionHolderPresent: false,
        holderIsAnonymous: false,
        isSessionWallLit: false,
      }),
    ).toBe(true);
  });

  it('lights when subscribed and a session member holds the wall', () => {
    expect(
      deriveLightbulbLit({
        localConnected: false,
        isSubscribedToBoardFeed: true,
        sessionHolderPresent: true,
        holderIsAnonymous: false,
        isSessionWallLit: false,
      }),
    ).toBe(true);
  });

  it('stays off when subscribed and the holder is not in my session (stranger / solo)', () => {
    // A board holder exists but they aren't a member of my session (or I'm solo):
    // session-scoped, so the bulb reads off even though the holder's avatar shows.
    expect(
      deriveLightbulbLit({
        localConnected: false,
        isSubscribedToBoardFeed: true,
        sessionHolderPresent: false,
        holderIsAnonymous: false,
        isSessionWallLit: false,
      }),
    ).toBe(false);
  });

  it('ignores a stuck session flag once the holder has cleared', () => {
    // The regression guard: the holder cleared (peer disconnected) but the
    // best-effort session flag is stuck true. With no holder, neither the
    // session-member nor the anonymous path can fire, so the bulb reads off.
    expect(
      deriveLightbulbLit({
        localConnected: false,
        isSubscribedToBoardFeed: true,
        sessionHolderPresent: false,
        holderIsAnonymous: false,
        isSessionWallLit: true,
      }),
    ).toBe(false);
  });

  it('falls back to the session flag for an anonymous holder in a session', () => {
    // An anonymous session peer can't be id-matched, so trust the session flag —
    // but only while a holder actually exists.
    expect(
      deriveLightbulbLit({
        localConnected: false,
        isSubscribedToBoardFeed: true,
        sessionHolderPresent: false,
        holderIsAnonymous: true,
        isSessionWallLit: true,
      }),
    ).toBe(true);

    expect(
      deriveLightbulbLit({
        localConnected: false,
        isSubscribedToBoardFeed: true,
        sessionHolderPresent: false,
        holderIsAnonymous: true,
        isSessionWallLit: false,
      }),
    ).toBe(false);
  });

  it('falls back to the session flag for a member that never bound the board', () => {
    expect(
      deriveLightbulbLit({
        localConnected: false,
        isSubscribedToBoardFeed: false,
        sessionHolderPresent: false,
        holderIsAnonymous: false,
        isSessionWallLit: true,
      }),
    ).toBe(true);

    expect(
      deriveLightbulbLit({
        localConnected: false,
        isSubscribedToBoardFeed: false,
        sessionHolderPresent: false,
        holderIsAnonymous: false,
        isSessionWallLit: false,
      }),
    ).toBe(false);
  });
});

describe('deriveBoardConnection', () => {
  it('is connectedByMe whenever this device holds the BLE link', () => {
    // Local connection wins over every other signal.
    expect(
      deriveBoardConnection({
        localConnected: true,
        isSubscribedToBoardFeed: true,
        sessionHolderPresent: true,
        holderIsAnonymous: false,
        isSessionWallLit: true,
      }),
    ).toBe('connectedByMe');
  });

  it('is heldByPeer when a session member holds the wall', () => {
    expect(
      deriveBoardConnection({
        localConnected: false,
        isSubscribedToBoardFeed: true,
        sessionHolderPresent: true,
        holderIsAnonymous: false,
        isSessionWallLit: false,
      }),
    ).toBe('heldByPeer');
  });

  it('is heldByPeer for an anonymous holder while the session reads lit', () => {
    expect(
      deriveBoardConnection({
        localConnected: false,
        isSubscribedToBoardFeed: true,
        sessionHolderPresent: false,
        holderIsAnonymous: true,
        isSessionWallLit: true,
      }),
    ).toBe('heldByPeer');
  });

  it('is heldByPeer for a member who never bound the board feed but the session is lit', () => {
    expect(
      deriveBoardConnection({
        localConnected: false,
        isSubscribedToBoardFeed: false,
        sessionHolderPresent: false,
        holderIsAnonymous: false,
        isSessionWallLit: true,
      }),
    ).toBe('heldByPeer');
  });

  it('is disconnected when nobody tied to me is driving', () => {
    // Subscribed, holder is a stranger / cleared, no session flag.
    expect(
      deriveBoardConnection({
        localConnected: false,
        isSubscribedToBoardFeed: true,
        sessionHolderPresent: false,
        holderIsAnonymous: false,
        isSessionWallLit: false,
      }),
    ).toBe('disconnected');

    // A stuck session flag with a cleared holder still reads disconnected.
    expect(
      deriveBoardConnection({
        localConnected: false,
        isSubscribedToBoardFeed: true,
        sessionHolderPresent: false,
        holderIsAnonymous: false,
        isSessionWallLit: true,
      }),
    ).toBe('disconnected');

    // No board feed, no session flag.
    expect(
      deriveBoardConnection({
        localConnected: false,
        isSubscribedToBoardFeed: false,
        sessionHolderPresent: false,
        holderIsAnonymous: false,
        isSessionWallLit: false,
      }),
    ).toBe('disconnected');
  });

  it('stays in lockstep with deriveLightbulbLit (lit ⇔ not disconnected) across all inputs', () => {
    const bools = [false, true];
    for (const localConnected of bools) {
      for (const isSubscribedToBoardFeed of bools) {
        for (const sessionHolderPresent of bools) {
          for (const holderIsAnonymous of bools) {
            for (const isSessionWallLit of bools) {
              const args = {
                localConnected,
                isSubscribedToBoardFeed,
                sessionHolderPresent,
                holderIsAnonymous,
                isSessionWallLit,
              };
              expect(deriveLightbulbLit(args)).toBe(deriveBoardConnection(args) !== 'disconnected');
            }
          }
        }
      }
    }
  });
});

describe('a wall with no LED light kit', () => {
  it('taps take and release the wall instead of connecting', () => {
    // Nothing to connect to — the tap takes the wall.
    expect(
      derivePlayDrawerLightbulbPressAction({
        hasBluetooth: true,
        isBluetoothConnected: false,
        isBluetoothLoading: false,
        ledless: true,
        wallHeld: false,
      }),
    ).toBe('takeWall');

    // Already holding it — the tap hands it back.
    expect(
      derivePlayDrawerLightbulbPressAction({
        hasBluetooth: true,
        isBluetoothConnected: false,
        isBluetoothLoading: false,
        ledless: true,
        wallHeld: true,
      }),
    ).toBe('releaseWall');
  });

  it('never returns connect on a ledless board', () => {
    for (const wallHeld of [false, true]) {
      for (const isBluetoothLoading of [false, true]) {
        expect(
          derivePlayDrawerLightbulbPressAction({
            hasBluetooth: true,
            isBluetoothConnected: false,
            isBluetoothLoading,
            ledless: true,
            wallHeld,
          }),
        ).not.toBe('connect');
      }
    }
  });

  it('still offers disconnect while actually BLE-connected, ledless or not', () => {
    // A board wrongly flagged as having no lights can still end up with a live
    // link (the creator header toggle, an iOS reconnect intent). Connected state
    // wins so the user is never stranded with no way to hang up.
    for (const ledless of [false, true]) {
      for (const wallHeld of [false, true]) {
        expect(
          derivePlayDrawerLightbulbPressAction({
            hasBluetooth: true,
            isBluetoothConnected: true,
            isBluetoothLoading: false,
            ledless,
            wallHeld,
          }),
        ).toBe('disconnect');
      }
    }
  });

  it('keeps the pre-existing behaviour when the ledless inputs are omitted', () => {
    expect(
      derivePlayDrawerLightbulbPressAction({
        hasBluetooth: true,
        isBluetoothConnected: false,
        isBluetoothLoading: false,
      }),
    ).toBe('connect');
  });
});

describe('deriveInAppBoardConnection', () => {
  const connections: BoardConnection[] = ['connectedByMe', 'heldByPeer', 'disconnected'];

  it('reads a virtual hold as this device driving the wall', () => {
    expect(
      deriveInAppBoardConnection({
        boardConnection: 'disconnected',
        ledless: true,
        wallHeld: true,
        wallHeldByOtherUser: false,
      }),
    ).toBe('connectedByMe');
  });

  it('yields to the server holder when another signed-in climber took the wall', () => {
    // A virtual hold has no radio enforcing exclusivity, so a stale local claim
    // must lose to the server's single holder slot.
    expect(
      deriveInAppBoardConnection({
        boardConnection: 'disconnected',
        ledless: true,
        wallHeld: true,
        wallHeldByOtherUser: true,
      }),
    ).toBe('heldByPeer');
  });

  it('shows a bystander on a ledless wall who is driving it, with no session', () => {
    // The population the issue is about: 413 boards have several climbers
    // reporting, only 36 have any party-session row. `boardConnection` only
    // reports a session member, so without this a climber watching someone
    // else's turn sees an open wall.
    expect(
      deriveInAppBoardConnection({
        boardConnection: 'disconnected',
        ledless: true,
        wallHeld: false,
        wallHeldByOtherUser: true,
      }),
    ).toBe('heldByPeer');
  });

  it('leaves a board WITH lights on the session-gated peer rule', () => {
    // There the holder can be a stranger sharing the board feed, and
    // deriveBoardConnection deliberately keeps them from lighting your bulb.
    expect(
      deriveInAppBoardConnection({
        boardConnection: 'disconnected',
        ledless: false,
        wallHeld: false,
        wallHeldByOtherUser: true,
      }),
    ).toBe('disconnected');
  });

  it('passes the BLE value straight through with no virtual hold and no peer holder', () => {
    for (const boardConnection of connections) {
      for (const ledless of [false, true]) {
        expect(
          deriveInAppBoardConnection({ boardConnection, ledless, wallHeld: false, wallHeldByOtherUser: false }),
        ).toBe(boardConnection);
      }
    }
  });

  it('never overrides a live BLE link with a peer holder', () => {
    for (const ledless of [false, true]) {
      expect(
        deriveInAppBoardConnection({
          boardConnection: 'connectedByMe',
          ledless,
          wallHeld: false,
          wallHeldByOtherUser: true,
        }),
      ).toBe('connectedByMe');
    }
  });
});

describe('deriveBoardConnection is the Live Activity contract', () => {
  it('is byte-identical for every input combination — a virtual hold cannot reach it', () => {
    // Pinned deliberately: the lock-screen bulb, Prev/Next and both native iOS
    // intents read this value, and none of them can write a wall with no lights.
    const bools = [false, true];
    const expected: Record<string, BoardConnection> = {};
    for (const localConnected of bools) {
      for (const isSubscribedToBoardFeed of bools) {
        for (const sessionHolderPresent of bools) {
          for (const holderIsAnonymous of bools) {
            for (const isSessionWallLit of bools) {
              const args = {
                localConnected,
                isSubscribedToBoardFeed,
                sessionHolderPresent,
                holderIsAnonymous,
                isSessionWallLit,
              };
              const key = Object.values(args)
                .map((flag) => (flag ? '1' : '0'))
                .join('');
              expected[key] = localConnected
                ? 'connectedByMe'
                : !isSubscribedToBoardFeed
                  ? isSessionWallLit
                    ? 'heldByPeer'
                    : 'disconnected'
                  : sessionHolderPresent || (holderIsAnonymous && isSessionWallLit)
                    ? 'heldByPeer'
                    : 'disconnected';
              expect(deriveBoardConnection(args)).toBe(expected[key]);
            }
          }
        }
      }
    }
    expect(Object.keys(expected)).toHaveLength(32);
  });
});
