import {
  driveModeEnded,
  driveModeStarted,
  SHARED_EVENTS,
  type AnalyticsEventProperties,
  type DriveModeEndedInput,
  type DriveModeStartedInput,
  type WallControlPreviewReason,
} from '@boardsesh/analytics';
import { track } from './analytics';
import type { WallControlAction, WallControlState } from '../components/play-drawer/wall-control';

/**
 * Which view of the board control was tapped or held: the wall button (full
 * width, or narrower in a workout's top row), the first row's bulb, or the open
 * MiniPlayer's bulb, standing in for a tablet or open-Duo player's (#7000).
 */
export type WallControlSurface = 'button' | 'bulb' | 'mini_bar';

/** `previewReason` only while the climb on screen is a preview: absent, not null, otherwise. */
function previewReasonProperty(previewReason: WallControlPreviewReason | null | undefined) {
  return previewReason ? { previewReason } : {};
}

/** The player's wall button asked the climber to act (see `WallControlShown` in events.ts). */
export function trackWallControlShown({
  state,
  climbUuid,
  previewReason,
}: {
  state: 'connect' | 'put_on_wall';
  climbUuid: string;
  /** Why the climb on screen is a preview (`wallControlPreviewReason`); null when it is not one. */
  previewReason?: WallControlPreviewReason | null;
}): void {
  track(SHARED_EVENTS.WallControlShown, { state, climbUuid, ...previewReasonProperty(previewReason) });
}

/** A tap on the player's wall button or bulb (see `WallControlTapped` in events.ts). */
export function trackWallControlTapped({
  state,
  action,
  control,
  analyticsContext,
  previewReason,
}: {
  analyticsContext?: AnalyticsEventProperties;
  state: WallControlState;
  action: WallControlAction;
  control: WallControlSurface;
  /** Why the climb on screen is a preview (`wallControlPreviewReason`); null when it is not one. */
  previewReason?: WallControlPreviewReason | null;
}): void {
  track(SHARED_EVENTS.WallControlTapped, {
    ...analyticsContext,
    state: state ?? 'none',
    action,
    control,
    ...previewReasonProperty(previewReason),
  });
}

/**
 * What a swipe on the wall button came to (#7113): `drive` started driving the
 * wall, `cancelled` let go short of the commit point, `refused` let go past it
 * where nothing could start (presence says another account holds the board).
 */
export type WallControlSwipeOutcome = 'drive' | 'cancelled' | 'refused';

/** A swipe on the player's wall button, once per gesture (see `WallControlSwiped` in events.ts). */
export function trackWallControlSwiped({
  state,
  outcome,
  control,
}: {
  state: WallControlState;
  outcome: WallControlSwipeOutcome;
  control: WallControlSurface;
}): void {
  track(SHARED_EVENTS.WallControlSwiped, { state: state ?? 'none', outcome, control });
}

/** Driving the wall started (2.7): once per drive, from the drive-mode store. */
export function trackDriveModeStarted(input: DriveModeStartedInput): void {
  const { name, properties } = driveModeStarted(input);
  track(name, properties);
}

/** Driving the wall ended (#7113): once per drive, from the drive-mode store. */
export function trackDriveModeEnded(input: DriveModeEndedInput): void {
  const { name, properties } = driveModeEnded(input);
  track(name, properties);
}
