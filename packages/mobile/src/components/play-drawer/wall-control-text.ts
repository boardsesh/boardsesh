import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  WallControlA11yHintKey,
  WallControlA11yValueKey,
  WallControlBulbValueKey,
  WallControlLabelKey,
  WallControlModel,
} from './wall-control';

// The words for a board control model (`resolveWallControl`), shared by every
// view of it, so the wall button, the bulb and the Duo's bar bulb can't word
// one state two ways. Each key is spelled out once here, so the catalog
// checks see every string the control can say.

export type WallControlText = {
  /** The wall button's label. Empty with nothing to offer. */
  label: string;
  /** The wall button's screen-reader label: the label, then where things stand ("Put on board, Sam has the board"). */
  accessibilityLabel: string;
  /** What a tap on the wall button does; the scanning and writing hints win while they apply. */
  accessibilityHint: string | undefined;
  /** What a tap on a bulb does (it never stops driving: a bulb draws no frost). */
  bulbAccessibilityHint: string | undefined;
  /** The bulb's own label ("Board lights"); its state rides `bulbValue`. */
  bulbAccessibilityLabel: string;
  bulbValue: string;
  /** The named accessibility action for a hold: "Board options". */
  longPressActionLabel: string;
  /** The named accessibility action for the swipe (#7113): "Light every climb". */
  driveActionLabel: string;
  /** The label once a swipe left has crossed the commit point (#7113): letting go starts driving the wall. */
  releaseLabel: string;
};

function labelText(
  t: TFunction,
  tSettings: TFunction,
  key: WallControlLabelKey,
  name: string | null,
  board: string | null,
): string {
  switch (key) {
    case 'putOnBoard':
      return t('playView.wallControl.putOnBoard');
    case 'setActive':
      return t('playView.setActive');
    case 'disconnectBoard':
      return t('playView.wallControl.disconnectBoard');
    case 'youAreDriving':
      return t('playView.wallControl.youAreDriving');
    case 'eachPickLights':
      return t('playView.wallControl.eachPickLights');
    case 'onBoard':
      return t('playView.wallControl.onBoard', { name });
    case 'onCrewBoard':
      return t('playView.wallControl.onCrewBoard');
    case 'onOtherPhone':
      return t('playView.wallControl.onOtherPhone');
    case 'takeWall':
      return tSettings('ble.takeWall');
    case 'releaseWall':
      return tSettings('ble.releaseWall');
    case 'putOnGymBoard':
      return t('playView.wallControl.putOnGymBoard', { board });
  }
}

function valueText(t: TFunction, key: WallControlA11yValueKey, name: string | null): string {
  switch (key) {
    case 'youHaveBoard':
      return t('playView.wallControl.youHaveBoard');
    case 'youHaveBoardLit':
      return t('playView.wallControl.youHaveBoardLit');
    case 'drivingEveryClimb':
      return t('playView.wallControl.drivingEveryClimb');
    case 'holderHasBoard':
      return t('playView.wallControl.holderHasBoard', { name });
    case 'crewHasBoard':
      return t('playView.wallControl.crewHasBoard');
    case 'onOtherPhone':
      return t('playView.wallControl.onOtherPhone');
    case 'onWall':
      return t('playView.wallControl.onWall');
  }
}

function hintText(t: TFunction, key: WallControlA11yHintKey, name: string | null, board: string | null): string {
  switch (key) {
    case 'connectHint':
      return t('playView.wallControl.connectHint');
    case 'lightHint':
      return t('playView.wallControl.lightHint');
    case 'lightAgainHint':
      return t('playView.wallControl.lightAgainHint');
    case 'litHint':
      return t('playView.wallControl.litHint');
    case 'stopDrivingHint':
      return t('playView.wallControl.stopDrivingHint');
    case 'stopWindowHint':
      return t('playView.wallControl.stopWindowHint');
    case 'relayHint':
      return t('playView.wallControl.relayHint', { name });
    case 'relayHintCrew':
      return t('playView.wallControl.relayHintCrew');
    case 'relayHintOtherPhone':
      return t('playView.wallControl.relayHintOtherPhone');
    case 'moveToGymBoardHint':
      return t('playView.wallControl.moveToGymBoardHint', { board });
  }
}

function bulbValueText(t: TFunction, key: WallControlBulbValueKey, name: string | null): string {
  switch (key) {
    case 'youHaveBoardLit':
      return t('playView.wallControl.youHaveBoardLit');
    case 'onWall':
      return t('playView.wallControl.onWall');
    case 'onBoard':
      return t('playView.wallControl.onBoard', { name });
    case 'onCrewBoard':
      return t('playView.wallControl.onCrewBoard');
    case 'onOtherPhone':
      return t('playView.wallControl.onOtherPhone');
    case 'valueOtherClimb':
      return t('playView.wallControl.valueOtherClimb');
    case 'valueOff':
      return t('playView.wallControl.valueOff');
  }
}

/** Pure, for tests: `t` is the session namespace, `tSettings` the settings one. */
export function wallControlText(model: WallControlModel, t: TFunction, tSettings: TFunction): WallControlText {
  const name = model.holderName;
  const board = model.gymBoardName;
  const label = model.labelKey ? labelText(t, tSettings, model.labelKey, name, board) : '';
  const spokenValue = model.a11yValueKey ? valueText(t, model.a11yValueKey, name) : null;
  const busyHint = model.pending ? tSettings('ble.scanning') : model.writing ? tSettings('ble.writing') : null;
  const accessibilityHint = busyHint ?? (model.a11yHintKey ? hintText(t, model.a11yHintKey, name, board) : undefined);
  const bulbAccessibilityHint =
    busyHint ?? (model.bulbA11yHintKey ? hintText(t, model.bulbA11yHintKey, name, board) : undefined);
  return {
    label,
    accessibilityLabel: spokenValue ? `${label}, ${spokenValue}` : label,
    accessibilityHint,
    bulbAccessibilityHint,
    bulbAccessibilityLabel: t('playView.wallControl.bulbAria'),
    bulbValue: bulbValueText(t, model.bulbValueKey, name),
    longPressActionLabel: t('playView.wallControl.boardOptions'),
    driveActionLabel: t('playView.wallControl.lightEveryClimb'),
    releaseLabel: t('playView.wallControl.releaseToDrive'),
  };
}

/** The words for one model, in the climber's language. */
export function useWallControlText(model: WallControlModel): WallControlText {
  const { t } = useTranslation('session');
  const { t: tSettings } = useTranslation('settings');
  return useMemo(() => wallControlText(model, t, tSettings), [model, t, tSettings]);
}

// Put on board's keep-lighting window (2.7, spec B2). The words and the digits
// are two runs: "Each pick lights" is the label (and the whole accessible
// name, so "Tap Each pick lights" works in Voice Control), the clock sits
// beside it, and the time left is the button's accessibility value.

/** Whole seconds left, rounded up, so the clock reads 0:01 until the window is over. */
export function windowSecondsLeft(remainingMs: number): number {
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

/** The clock beside Each pick lights: m:ss ("0:38", "1:00"). */
export function formatWindowClock(remainingMs: number): string {
  const seconds = windowSecondsLeft(remainingMs);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The time left for the screen reader, on a 10 s step so TalkBack doesn't
 * re-read every tick while focus rests on the button: 30 from 30 to 39.9 s
 * (never more than is left), 0 under ten.
 */
export function windowValueSeconds(remainingMs: number): number {
  const seconds = Math.max(0, Math.floor(remainingMs / 1000));
  return seconds < 10 ? 0 : Math.floor(seconds / 10) * 10;
}

/** "30 seconds left", then "Under 10 seconds left" (`windowValueSeconds`). */
export function windowTimeValue(remainingMs: number, t: TFunction): string {
  const seconds = windowValueSeconds(remainingMs);
  if (seconds < 10) return t('playView.wallControl.underTenSeconds');
  return t('playView.wallControl.secondsLeft', { count: seconds });
}

/** Said once when the window opens: how long, and how to keep lighting (WCAG 2.2.1). */
export function windowStartedAnnouncement(windowMs: number, t: TFunction): string {
  const seconds = Math.round(windowMs / 1000);
  if (seconds === 60) return t('playView.wallControl.windowStartedMinute');
  return t('playView.wallControl.windowStarted', { count: seconds });
}
