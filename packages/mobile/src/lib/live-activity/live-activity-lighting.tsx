// Feeds the keep-lighting window (2.7) to the Lock Screen, the Dynamic Island
// and the Android session notification, and mirrors Settings › Board's
// keep-lighting choices so a lock-screen Next or Previous can open or renew
// the window natively while JS is suspended.
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
import { DEFAULT_KEEP_LIGHTING, DEFAULT_MOONBOARD_KEEP_LIGHTING, sanitiseKeepLighting } from '../keep-lighting';
import {
  getDriveLightingSnapshot,
  getDriveMode,
  subscribeDriveMode,
} from '../../components/play-drawer/drive-mode-store';
import { isUnsettledLockScreenLighting } from '../../components/play-drawer/lock-screen-lighting';
import {
  readLiveActivityLightingWindow,
  sessionPresenceSupportsLightingWindow,
  updateLiveActivityKeepLightingConfig,
  updateLiveActivityLightingWindow,
} from './live-activity-plugin';
import { buildKeepLightingConfig, buildLightingWindowPayload } from './lighting-window-payload';

type UseLiveActivityLightingOptions = {
  sessionId: string | null;
  boardName: string;
  /**
   * Bumped by useLiveActivity after every successful start. Native clears the
   * settings when a session ends and the window when another session starts,
   * so each start re-sends both.
   */
  activityStartCount: number;
};

export function useLiveActivityLighting({
  sessionId,
  boardName,
  activityStartCount,
}: UseLiveActivityLightingOptions): void {
  const [storedKeepLighting] = useSetting('putOnBoardKeepsLighting');
  const [storedMoonboardKeepLighting] = useSetting('moonboardPutOnBoardKeepsLighting');
  const [drivesInSession] = useSetting('putOnBoardDrivesInSession');
  const [lightOnSwipe] = useSetting('lightOnSwipe');
  const keepLighting = sanitiseKeepLighting(storedKeepLighting, DEFAULT_KEEP_LIGHTING);
  const moonboardKeepLighting = sanitiseKeepLighting(storedMoonboardKeepLighting, DEFAULT_MOONBOARD_KEEP_LIGHTING);
  // The roster's crew, as Put on board and DriveModeWatcher read it.
  const isCrewSession = useIsCrewSession();
  const swipeToDriveEnabled = useWallSwipeToDriveEnabled();

  // `undefined` until the first send, so the mount always speaks.
  const lastConfigRef = useRef<string | undefined>(undefined);
  const lastConfigStartRef = useRef(activityStartCount);
  useEffect(() => {
    // A binary that predates the window (this JS over the air) has nowhere to put it.
    if (!sessionPresenceSupportsLightingWindow) return;
    const config = sessionId
      ? buildKeepLightingConfig({
          keepLighting,
          moonboardKeepLighting,
          drivesInSession,
          isCrewSession,
          boardName,
          swipeToDriveEnabled,
          lightOnSwipe,
        })
      : null;
    const serialized = JSON.stringify(config);
    const restarted = lastConfigStartRef.current !== activityStartCount;
    lastConfigStartRef.current = activityStartCount;
    if (!restarted && serialized === lastConfigRef.current) return;
    lastConfigRef.current = serialized;
    void updateLiveActivityKeepLightingConfig(config);
  }, [
    sessionId,
    keepLighting,
    moonboardKeepLighting,
    drivesInSession,
    isCrewSession,
    boardName,
    swipeToDriveEnabled,
    lightOnSwipe,
    activityStartCount,
  ]);

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
      // A window the climber opened from the Lock Screen that the drive store
      // has not adopted yet is never covered with "off": DriveModeWatcher
      // adopts it the moment it can, or it runs out on its own.
      if (payload?.mode === 'off' && isUnsettledLockScreenLighting(readLiveActivityLightingWindow(), Date.now())) {
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
