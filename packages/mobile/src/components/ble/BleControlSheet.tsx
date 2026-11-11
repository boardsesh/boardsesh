import { useCallback, type ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../ModalSheet';
import { ListRow } from '../ListRow';
import { Separator } from '../Separator';
import { SwitchRow } from '../SwitchRow';
import { Icon } from '../Icon';
import { BleKeepLightingRow, type BleKeepLightingRowModel } from './BleKeepLightingRow';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

type BleControlSheetProps = {
  visible: boolean;
  /** Re-push the current climb to the wall (same as a lightbulb tap). */
  onReassert: () => void;
  /** Clear every LED on the wall, keeping the connection alive. */
  onClearLights: () => void;
  /** Drop the BLE connection. */
  onDisconnect: () => void;
  /** Disconnect Bluetooth when driving ends (2.7): let go of the board when a drive ends. */
  disconnectWhenDrivingEnds: boolean;
  onToggleDisconnectWhenDrivingEnds: (enabled: boolean) => void;
  /** Show the MoonBoard "light hold above" row — only when the connected
   * board is a MoonBoard. */
  showLightAdjacentHolds: boolean;
  lightAdjacentHoldsEnabled: boolean;
  onToggleLightAdjacentHolds: (enabled: boolean) => void;
  /** Always drive the wall: this phone drives the wall while it holds the board. */
  alwaysDrive: boolean;
  onToggleAlwaysDrive: (enabled: boolean) => void;
  /**
   * Disconnect Bluetooth when driving ends and Always drive the wall. The
   * player's own sheet (#7000) leaves them to Settings › Board, where they
   * also live, so the sheet is just the board's actions. Today's bar keeps them.
   */
  showLightingSwitches?: boolean;
  /** Disconnecting when the drive ends applies to a Bluetooth connection. */
  showDisconnectWhenDrivingEnds?: boolean;
  /**
   * This phone's link is up. Without it the board's own actions (Re-light,
   * Turn off all lights, Disconnect) would no-op, so only Light every climb
   * shows. Defaults to true: every sheet but the player's opens linked.
   */
  linked?: boolean;
  /**
   * Light every climb (#7113): start driving the wall, the wall button's swipe
   * as a row. First among the board's actions, where the player offers the swipe.
   */
  onDrive?: () => void;
  /**
   * The player's status line at the top (spec B3): what the wall button says,
   * in full at any text size, since the button's own label is capped.
   */
  status?: ReactNode;
  /**
   * Stop driving after (2.7, spec B4), the first row: the timer changed or set
   * to Right away at the wall in two taps. Omitted, no row: the host leaves it
   * out while Always drive the wall drives, where it doesn't apply.
   */
  keepLighting?: BleKeepLightingRowModel;
  onClose: () => void;
};

// Secondary BLE controls (Re-light / Turn off all lights / Disconnect) revealed
// by long-pressing the lightbulb — keeps the destructive Disconnect behind a
// labelled menu.
function BleControlSheet({
  visible,
  onReassert,
  onClearLights,
  onDisconnect,
  disconnectWhenDrivingEnds,
  onToggleDisconnectWhenDrivingEnds,
  showLightAdjacentHolds,
  lightAdjacentHoldsEnabled,
  onToggleLightAdjacentHolds,
  alwaysDrive,
  onToggleAlwaysDrive,
  showLightingSwitches = true,
  showDisconnectWhenDrivingEnds = true,
  linked = true,
  onDrive,
  status,
  keepLighting,
  onClose,
}: BleControlSheetProps) {
  const { t: tSettings } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  const { t: tSession } = useTranslation('session');
  const { brandColors, systemColors } = useTheme();

  const handleReassert = useCallback(() => {
    onReassert();
    onClose();
  }, [onReassert, onClose]);

  const handleClearLights = useCallback(() => {
    onClearLights();
    onClose();
  }, [onClearLights, onClose]);

  const handleDisconnect = useCallback(() => {
    onDisconnect();
    onClose();
  }, [onDisconnect, onClose]);

  const handleDrive = useCallback(() => {
    onDrive?.();
    onClose();
  }, [onDrive, onClose]);

  return (
    // A bounded large detent lets the scroll view reach every native Toggle and
    // the Disconnect action at accessibility text sizes on a small iPhone.
    <ModalSheet visible={visible} snapPoints={['90%']} scrollable onClose={onClose} enablePanDownToClose>
      <View style={styles.content}>
        {status ? <View style={styles.status}>{status}</View> : null}
        {keepLighting ? <BleKeepLightingRow model={keepLighting} /> : null}
        {/* The app's native SwitchRow (SwiftUI Toggle / Compose Switch) instead of
            raw RN Switches, which render system green on iOS: HIG Color asks for
            one tint across every control. */}
        {/* Under Stop driving after, as on Settings › Board: what happens when the drive ends. */}
        {showLightingSwitches && showDisconnectWhenDrivingEnds && (
          <SwitchRow
            label={tSettings('ble.lighting.drivingEnds.label')}
            description={tSettings('ble.lighting.drivingEnds.description')}
            wrapDescription
            value={disconnectWhenDrivingEnds}
            onValueChange={onToggleDisconnectWhenDrivingEnds}
          />
        )}
        {showLightAdjacentHolds && (
          <SwitchRow
            label={tCommon('lightControl.lightAdjacentHolds')}
            description={tCommon('lightControl.lightAdjacentHoldsHelp')}
            wrapDescription
            value={lightAdjacentHoldsEnabled}
            onValueChange={onToggleLightAdjacentHolds}
          />
        )}
        {/* As on Settings › Board: one switch that always drives the wall. */}
        {showLightingSwitches && (
          <SwitchRow
            label={tSettings('ble.lighting.alwaysDriveLabel')}
            description={tSettings('ble.lighting.alwaysDriveDescription')}
            wrapDescription
            value={alwaysDrive}
            onValueChange={onToggleAlwaysDrive}
          />
        )}
        {showLightingSwitches || showLightAdjacentHolds || keepLighting ? <Separator /> : null}
        {onDrive ? (
          <ListRow
            testID="ble-control-drive"
            title={tSession('playView.wallControl.lightEveryClimb')}
            leading={<Icon name="chevron.left.2" size={22} color={brandColors.primary} />}
            onPress={handleDrive}
            showSeparator={linked}
          />
        ) : null}
        {linked ? (
          <>
            <ListRow
              testID="ble-control-relight"
              title={tSettings('ble.relightBoard')}
              leading={<Icon name="lightbulb.fill" size={22} color={brandColors.warning} />}
              onPress={handleReassert}
              showSeparator
            />
            <ListRow
              testID="ble-control-clear"
              title={tCommon('lightControl.turnOffAll')}
              leading={<Icon name="lightbulb.slash" size={22} color={systemColors.secondaryLabel} />}
              onPress={handleClearLights}
              showSeparator
            />
            <ListRow
              testID="ble-control-disconnect"
              title={tCommon('lightControl.disconnect')}
              leading={<Icon name="bluetooth.off" size={22} color={systemColors.error} />}
              onPress={handleDisconnect}
              showSeparator={false}
            />
          </>
        ) : null}
      </View>
    </ModalSheet>
  );
}

export { BleControlSheet };

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing[2],
  },
  status: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
});
