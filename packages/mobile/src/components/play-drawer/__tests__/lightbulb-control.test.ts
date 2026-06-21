import { describe, expect, it } from 'vitest';
import {
  buildPlayDrawerBoardLayout,
  deriveBoardConnection,
  deriveLightbulbLit,
  derivePlayDrawerLightbulbPressAction,
} from '../lightbulb-control';

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

  it('builds the analytics board-layout key', () => {
    expect(buildPlayDrawerBoardLayout({ boardName: 'kilter', layoutId: 1, sizeId: 10 })).toBe('kilter:1:10');
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
