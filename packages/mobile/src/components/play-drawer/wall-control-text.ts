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
  /** What a tap does; the scanning and writing hints win while they apply. */
  accessibilityHint: string | undefined;
  /** The bulb's own label ("Board lights"); its state rides `bulbValue`. */
  bulbAccessibilityLabel: string;
  bulbValue: string;
  /** The named accessibility action for a hold: "Board options". */
  longPressActionLabel: string;
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
  let accessibilityHint: string | undefined = model.a11yHintKey
    ? hintText(t, model.a11yHintKey, name, board)
    : undefined;
  if (model.pending) accessibilityHint = tSettings('ble.scanning');
  else if (model.writing) accessibilityHint = tSettings('ble.writing');
  return {
    label,
    accessibilityLabel: spokenValue ? `${label}, ${spokenValue}` : label,
    accessibilityHint,
    bulbAccessibilityLabel: t('playView.wallControl.bulbAria'),
    bulbValue: bulbValueText(t, model.bulbValueKey, name),
    longPressActionLabel: t('playView.wallControl.boardOptions'),
  };
}

/** The words for one model, in the climber's language. */
export function useWallControlText(model: WallControlModel): WallControlText {
  const { t } = useTranslation('session');
  const { t: tSettings } = useTranslation('settings');
  return useMemo(() => wallControlText(model, t, tSettings), [model, t, tSettings]);
}
