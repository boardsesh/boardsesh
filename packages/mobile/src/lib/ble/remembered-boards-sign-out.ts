// Sign-out forgets every board this phone remembers.
//
// A hang-up keeps the board for 10 minutes (remembered-board-expiry.ts), and a
// link drop keeps it with no limit. Neither may outlive the account: on a phone
// handed to the next climber, their first bulb tap must open the board picker,
// not silently take the box the last account held.
//
// AuthProvider sits above BluetoothProvider, so it can't reach the hook's
// in-memory record directly. It calls `forgetRememberedBoardsOnSignOut`, which
// tells every mounted useBoardBluetooth (its in-memory record, its per-board
// handles and the iOS native pairing) and clears both stores itself, so a
// sign-out with no hook mounted still leaves nothing behind.

import { clearStoredLastConnectedBoard } from './last-connected-board-store';
import { setStoredKnownBoardDevices } from './known-board-devices-store';

type SignOutListener = () => void;

const signOutListeners = new Set<SignOutListener>();

/** Called by useBoardBluetooth: forget its remembered boards when the account signs out. */
export function subscribeRememberedBoardsSignOut(listener: SignOutListener): () => void {
  signOutListeners.add(listener);
  return () => {
    signOutListeners.delete(listener);
  };
}

/** Called by AuthProvider's signed-out cleanup. Storage failures are swallowed: never a thrown sign-out. */
export async function forgetRememberedBoardsOnSignOut(): Promise<void> {
  for (const listener of Array.from(signOutListeners)) {
    try {
      listener();
    } catch {
      // One listener's failure must not keep the others, or the stores, remembered.
    }
  }
  await Promise.allSettled([clearStoredLastConnectedBoard(), setStoredKnownBoardDevices([])]);
}
