import { isMoonboardBoardName } from '@boardsesh/board-config';
import type { DriveLightingSnapshot, DriveModeState } from '../../components/play-drawer/drive-mode-store';
import type { KeepLightingChoice, KeepLightingSettingKey } from '../keep-lighting';
import type {
  LiveActivityKeepLightingConfig,
  LiveActivityLightingFamily,
  LiveActivityLightingWindowOptions,
} from '../../../modules/live-activity/src/index';

/**
 * The keep-lighting window (2.7) as the Lock Screen, the Dynamic Island and
 * the Android notification draw it, from the drive store's seam
 * (`getDriveLightingSnapshot`). Arming reads as off: nothing lights a pick
 * until the wall confirms the first climb. Null outside a session: there is no
 * card to draw it on.
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
 * Settings › Board's keep-lighting choices for the lock-screen and
 * notification Next / Previous, which open or renew the window natively the
 * way Put on board would (`resolveKeepLightingPlan` reads the same inputs).
 *
 * `enabled` is false where a press would not keep lighting in the app either:
 * the swipe flag (keep-lighting's kill switch) is off, or the climber lights
 * every pick solo with Light the board as I swipe (the press only drops a stop
 * there, `wall-control.ts`).
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
    enabled: swipeToDriveEnabled && !(lightOnSwipe && !isCrewSession),
  };
}
