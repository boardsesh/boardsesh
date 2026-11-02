import { isMoonboardBoardName } from '@boardsesh/board-config';
import type { DriveLightingSnapshot, DriveModeState } from '../../components/play-drawer/drive-mode-store';
import { lockScreenPressKeepsLighting, type KeepLightingChoice, type KeepLightingSettingKey } from '../keep-lighting';
import type {
  LiveActivityKeepLightingConfig,
  LiveActivityLightingFamily,
  LiveActivityLightingWindowOptions,
} from '../../../modules/live-activity/src/index';

/**
 * This phone's drive (2.7) as the Lock Screen, the Dynamic Island and the
 * Android notification draw it, from the drive store's seam
 * (`getDriveLightingSnapshot`): Put on board's timed drive (`window`, with its
 * own end and length), an open-ended drive (`driving`, no clock), or off.
 * Arming reads as off: nothing lights a pick until the wall confirms the first
 * climb. Null outside a session: there is no card to draw it on.
 */
export function buildLightingWindowPayload({
  sessionId,
  drive,
  lighting,
}: {
  sessionId: string | null;
  drive: DriveModeState | null;
  lighting: DriveLightingSnapshot;
}): LiveActivityLightingWindowOptions | null {
  if (!sessionId) return null;
  if (lighting.mode === 'window' && lighting.endsAt !== null && drive?.windowMs != null) {
    return {
      sessionId,
      mode: 'window',
      endsAtMs: lighting.endsAt,
      windowSeconds: drive.windowMs / 1000,
      family: familyOf(drive.windowSetting),
    };
  }
  if (lighting.mode === 'driving') {
    return { sessionId, mode: 'driving', endsAtMs: null, windowSeconds: null, family: null };
  }
  return { sessionId, mode: 'off', endsAtMs: null, windowSeconds: null, family: null };
}

function familyOf(setting: KeepLightingSettingKey | null): LiveActivityLightingFamily | null {
  if (setting === 'moonboardPutOnBoardKeepsLighting') return 'moonboard';
  if (setting === 'putOnBoardKeepsLighting') return 'general';
  return null;
}

/**
 * Settings › Board's Stop driving after choices for the iOS Lock Screen and
 * Dynamic Island Next / Previous, which light the wall without JS and so start
 * or renew a drive natively, the way Put on board would
 * (`resolveKeepLightingPlan` reads the same inputs); Right away starts none.
 * Android mirrors nothing: JS lights the wall for a notification press and
 * starts the drive itself (`armNotificationPressDrive`).
 *
 * `enabled` is `lockScreenPressKeepsLighting`: false where a press would not
 * start a drive in the app either. `lockScreenStop` says this JS takes a stop
 * from the Lock Screen bulb; a binary without one ignores it.
 */
export function buildKeepLightingConfig({
  keepLighting,
  moonboardKeepLighting,
  drivesInSession,
  isCrewSession,
  boardName,
  swipeToDriveEnabled,
  lightOnSwipe,
}: {
  keepLighting: KeepLightingChoice;
  moonboardKeepLighting: KeepLightingChoice;
  drivesInSession: boolean;
  /** The roster's crew (`useIsCrewSession`), as the press reads it. */
  isCrewSession: boolean;
  boardName: string;
  swipeToDriveEnabled: boolean;
  lightOnSwipe: boolean;
}): LiveActivityKeepLightingConfig {
  return {
    keepLighting,
    moonboardKeepLighting,
    drivesInSession,
    inCrew: isCrewSession,
    moonboard: isMoonboardBoardName(boardName),
    enabled: lockScreenPressKeepsLighting({ swipeToDriveEnabled, lightOnSwipe, inSession: isCrewSession }),
    // This JS adopts a lock-screen stop (`lock-screen-lighting.ts`), so the
    // bulb may offer one while a drive is on the card.
    lockScreenStop: true,
  };
}
