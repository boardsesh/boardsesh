import { useEffect, useRef } from 'react';
import { InteractionManager } from 'react-native';
import { syncEarlyUpdates } from '../../lib/qa/early-updates';
import { adoptRunningOtaPin } from '../../lib/qa/qa-surf';
import { useEarlyUpdatesSyncEnvironment } from '../../lib/qa/use-early-updates';

/**
 * Brings the phone's OTA branch pin in line with the "Get updates early" choice
 * once per launch. Renders nothing.
 *
 * That is a join the switch could not finish (offline, or the server had no
 * early update for this binary yet), a leave it could not finish, or the
 * feature being switched off for a member. Each needs a download, so this runs
 * after the first interactions, in the background, and never blocks launch or
 * reloads: whatever it changes takes effect the next time the app opens. A
 * phone whose pin already matches its choice makes no request at all.
 *
 * The policy is `decideEarlyUpdatesSync`; the cold-start table at the top of
 * `early-updates.ts` says what launches in every state this can leave behind.
 */
export function EarlyUpdatesLaunchSync() {
  const environment = useEarlyUpdatesSyncEnvironment();
  const { surfingBuild, surfingReady } = environment;
  const adoptedRef = useRef(false);

  useEffect(() => {
    if (!surfingBuild || !surfingReady) return;
    // Before the first sync, and only once: the running bundle proves which pin
    // was in force at LAUNCH, and stops proving it the moment anything switches.
    if (!adoptedRef.current) {
      adoptedRef.current = true;
      adoptRunningOtaPin();
    }
    // Re-run when the flag lands or changes. `syncEarlyUpdates` decides from
    // the pin record, so a repeat with nothing left to do is a no-op.
    const interaction = InteractionManager.runAfterInteractions(() => {
      void syncEarlyUpdates(environment);
    });
    return () => interaction.cancel();
  }, [environment, surfingBuild, surfingReady]);

  return null;
}
