import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { BleLightbulbButton } from '../ble/BleLightbulbButton';
import { BoardDriverAvatar } from '../board-presence/BoardDriverAvatar';
import { SIZES } from '../drawer-action-bar/DrawerActionBar';
import type { WallControlModel } from './wall-control';
import { useWallControlText } from './wall-control-text';

type WallControlBulbProps = {
  model: WallControlModel;
  /**
   * Draw the holder's face on the bulb's corner. Off while the header's back
   * chip already shows the driver (`shouldShowHolderBadge`), so one face shows once.
   */
  showFace?: boolean;
  onPress: () => void;
  onLongPress: () => void;
};

/**
 * The board control as the first row's bulb (#7000): grey outline with no
 * board, filled amber whenever this phone holds the board (any state) or a
 * crewmate's climb is lit, amber outline when the board is on the wall but not
 * this phone's, and the holder's face on its
 * corner. It draws a `WallControlModel` and nothing else; the face comes from
 * `model.holderFace`, never from board presence, so it goes the moment the
 * link does. Taps and holds go to `useWallControl`, which buzzes and logs.
 */
function WallControlBulbComponent({ model, showFace = true, onPress, onLongPress }: WallControlBulbProps) {
  const text = useWallControlText(model);
  const hold = model.longPress === 'sheet';
  const face = showFace ? model.holderFace : null;
  return (
    <View testID="play-drawer-wall-bulb">
      <BleLightbulbButton
        isConnected={model.look === 'lit'}
        ready={model.look === 'ready'}
        accessibilitySelected={model.selected}
        accessibilityValueText={text.bulbValue}
        accessibilityTapHint={text.accessibilityHint}
        isScanning={model.pending}
        writing={model.writing}
        autoDisconnectWarning={model.autoDisconnectWarning}
        onPress={onPress}
        onLongPress={hold ? onLongPress : undefined}
        longPressHaptic={false}
        longPressActionLabel={text.longPressActionLabel}
        accessibilityLabel={text.bulbAccessibilityLabel}
        haptic="none"
        size={SIZES.lg.icon}
        containerSize={SIZES.lg.dim}
      />
      {face ? (
        <View
          style={styles.face}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID="play-drawer-wall-bulb-holder"
        >
          <BoardDriverAvatar size={18} userId={null} uri={face.avatarUrl} name={face.name} status="none" />
        </View>
      ) : null}
    </View>
  );
}

export const WallControlBulb = memo(WallControlBulbComponent);

const styles = StyleSheet.create({
  // The holder's face on the bulb's top-right corner.
  face: {
    position: 'absolute',
    top: -2,
    right: -2,
  },
});
