import { BOARD_LOOK_STEP_SEEN_KEY } from '@boardsesh/key-value-storage';
import { secureStorePreferences } from '../preferences/secure-store-adapter';
import { setBoardRenderModePreference } from '../board-render-settings';

/**
 * Show the one-time board-look step again.
 *
 * Clearing the "seen" flag is not enough on its own: the gate also skips anyone
 * whose stored mode is no longer `'default'`, and picking a look — or touching
 * the Render control on the Board look screen — is exactly what sets it. So
 * anyone who has already answered the question, in either place, needs BOTH
 * reset to see it again. That is most of the people who would want to replay it.
 *
 * Both writes are awaited before navigating, for the reason `replayOnboarding`
 * documents: a replayed step that is answered before the clears settle would let
 * its own write land first, and the late clear would then wipe it — leaving the
 * step "unseen" and re-firing on the next cold start.
 *
 * `navigate` is injected so this stays unit-testable without Expo Router.
 */
export async function replayBoardLookStep(navigate: () => void): Promise<void> {
  await Promise.all([secureStorePreferences.remove(BOARD_LOOK_STEP_SEEN_KEY), setBoardRenderModePreference('default')]);
  navigate();
}
