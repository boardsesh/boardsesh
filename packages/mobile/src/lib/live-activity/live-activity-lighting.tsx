// Feeds driving the wall (2.7) to the Lock Screen, the Dynamic Island and the
// Android session notification: Put on board's timed drive with its end (the
// iOS draining ring and timer, Android's header countdown), an open-ended
// drive with none, or off. On iOS it also mirrors Settings › Board's Stop
// driving after choices so a Lock Screen Next or Previous can start or renew a
// drive natively while JS is suspended. Android mirrors nothing: JS lights the
// wall for a notification press and starts the drive itself
// (`armNotificationPressDrive`). The card always shows the wall's climb (the
// queue's current), never the MiniPlayer's last pick.
//
// PERFORMANCE CONTRACT: no per-second work. The native side counts the window
// down with self-updating views (iOS timer text and ring, Android's header
// chronometer), so JS only speaks when the drive changes (start, live, a
// renewal, the end), when a setting changes, and after each Live Activity
// start. Mounted as its own null-render leaf so drive-store events never
// re-render the bridge.

import { useEffect, useRef } from 'react';
import { useWallSwipeToDriveEnabled } from '../../providers/feature-flags-provider';
import { useIsCrewSession } from '../../providers/queue-provider';
import { useSetting } from '../../settings';
import { DEFAULT_KEEP_LIGHTING, sanitiseKeepLighting } from '../keep-lighting';
import {
  getDriveLightingSnapshot,
  getDriveMode,
  subscribeDriveMode,
} from '../../components/play-drawer/drive-mode-store';
import {
  isUnsettledLockScreenLighting,
  isUnsettledLockScreenStop,
} from '../../components/play-drawer/lock-screen-lighting';
import {
  readLiveActivityLightingWindow,
  sessionPresenceMirrorsKeepLighting,
  sessionPresenceSupportsLightingWindow,
  updateLiveActivityKeepLightingConfig,
  updateLiveActivityLightingWindow,
} from './live-activity-plugin';
import { buildKeepLightingConfig, buildLightingWindowPayload } from './lighting-window-payload';

type UseLiveActivityLightingOptions = {
  sessionId: string | null;
  /**
   * Bumped by useLiveActivity after every successful start. Native clears the
   * settings (iOS) when a session ends and the window when another session
   * starts, so each start re-sends both.
   */
  activityStartCount: number;
};

export function useLiveActivityLighting({ sessionId, activityStartCount }: UseLiveActivityLightingOptions): void {
  const [storedKeepLighting] = useSetting('putOnBoardKeepsLighting');
  const [drivesInSession] = useSetting('putOnBoardDrivesInSession');
  const [alwaysDrive] = useSetting('alwaysDrive');
  const keepLighting = sanitiseKeepLighting(storedKeepLighting, DEFAULT_KEEP_LIGHTING);
  // The roster's crew, as Put on board and DriveModeWatcher read it.
  const isCrewSession = useIsCrewSession();
  const swipeToDriveEnabled = useWallSwipeToDriveEnabled();

  // `undefined` until the first send, so the mount always speaks.
  const lastConfigRef = useRef<string | undefined>(undefined);
  const lastConfigStartRef = useRef(activityStartCount);
  useEffect(() => {
    // Only iOS reads it, and not a binary that predates the window (this JS
    // over the air).
    if (!sessionPresenceMirrorsKeepLighting) return;
    const config = sessionId
      ? buildKeepLightingConfig({
          keepLighting,
          drivesInSession,
          isCrewSession,
          swipeToDriveEnabled,
          alwaysDrive,
        })
      : null;
    const serialized = JSON.stringify(config);
    const restarted = lastConfigStartRef.current !== activityStartCount;
    lastConfigStartRef.current = activityStartCount;
    if (!restarted && serialized === lastConfigRef.current) return;
    lastConfigRef.current = serialized;
    void updateLiveActivityKeepLightingConfig(config);
  }, [sessionId, keepLighting, drivesInSession, isCrewSession, swipeToDriveEnabled, alwaysDrive, activityStartCount]);

  useEffect(() => {
    if (!sessionPresenceSupportsLightingWindow) return undefined;
    // A new session or a fresh start re-sends whatever the drive is.
    let lastSent: string | undefined;
    const send = () => {
      const payload = buildLightingWindowPayload({
        sessionId,
        drive: getDriveMode(),
        lighting: getDriveLightingSnapshot(),
      });
      const serialized = JSON.stringify(payload);
      if (serialized === lastSent) return;
      // A drive the climber started from the Lock Screen that the drive store
      // has not adopted yet is never covered with "off": DriveModeWatcher
      // adopts it the moment it can, or it runs out on its own.
      if (payload?.mode === 'off' && isUnsettledLockScreenLighting(readLiveActivityLightingWindow(), Date.now())) {
        return;
      }
      // Nor is a drive the climber stopped from the Lock Screen put back on the
      // card before the drive store adopted the stop: it ends the drive the
      // moment it can, and this sends "off" then.
      if (
        payload !== null &&
        payload.mode !== 'off' &&
        isUnsettledLockScreenStop(readLiveActivityLightingWindow(), getDriveMode())
      ) {
        return;
      }
      lastSent = serialized;
      void updateLiveActivityLightingWindow(payload);
    };
    send();
    return subscribeDriveMode(send);
  }, [sessionId, activityStartCount]);
}

/** Renderless host for {@link useLiveActivityLighting}; see the file header. */
export function LiveActivityLightingSync(props: UseLiveActivityLightingOptions): null {
  useLiveActivityLighting(props);
  return null;
}
