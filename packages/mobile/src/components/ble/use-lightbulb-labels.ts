import { useTranslation } from 'react-i18next';
import type { PlayDrawerLightbulbPressAction } from '../play-drawer/lightbulb-control';
import { getBleLightbulbLabelKind } from './ble-lightbulb-button-state';

/** Labels follow the resolved action, including transports with explicit controls. */
export function useLightbulbLabels(pressAction: PlayDrawerLightbulbPressAction, holderIsAuthoritative = false) {
  const { t: tCommon } = useTranslation('common');
  const { t: tSettings } = useTranslation('settings');
  const labelKind = getBleLightbulbLabelKind(pressAction, holderIsAuthoritative);
  let accessibilityLabel: string;
  switch (labelKind) {
    case 'openControls':
      accessibilityLabel = tCommon('lightControl.quantum.open');
      break;
    case 'disconnect':
      accessibilityLabel = tCommon('lightControl.disconnect');
      break;
    case 'takeWall':
      accessibilityLabel = tSettings('ble.takeWall');
      break;
    case 'releaseWall':
      accessibilityLabel = tSettings('ble.releaseWall');
      break;
    case 'relay':
      accessibilityLabel = tSettings('ble.relayToWall');
      break;
    case 'peerDriving':
      accessibilityLabel = tSettings('ble.peerDrivingBoard');
      break;
    default:
      accessibilityLabel = tSettings('ble.connectBoard');
  }
  return {
    accessibilityLabel,
    drivingAccessibilityLabel:
      pressAction === 'openControls' ? accessibilityLabel : tSettings('ble.barControl.stopDrivingLabel'),
  };
}
