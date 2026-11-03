import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { BleLightbulbButton } from '../ble/BleLightbulbButton';
import { BoardDriverAvatar } from '../board-presence/BoardDriverAvatar';
import { SIZES } from '../drawer-action-bar/DrawerActionBar';
import type { WallControlModel } from './wall-control';
import { useWallControlText } from './wall-control-text';
import { useWindowValueText, WallWindowRing } from './WallWindowRing';

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
 * Its tap is the wall button's (`tapAction`): during any drive it stops
 * driving and keeps the link, and its hint says so (owner, 2026-11-03).
 * During Put on board's timed drive an amber arc drains round it and its value
 * says the time left (spec B3). The halo goes for that drive, as on the
 * MiniPlayer's bulbs and the Live Activity, so the arc meets the row itself.
 */
function WallControlBulbComponent({ model, showFace = true, onPress, onLongPress }: WallControlBulbProps) {
  const text = useWallControlText(model);
  const windowValue = useWindowValueText(model.lightWindow);
  const hold = model.longPress === 'sheet';
  const face = showFace ? model.holderFace : null;
  return (
    <View testID="play-drawer-wall-bulb">
      <BleLightbulbButton
        isConnected={model.look === 'lit' || model.look === 'driving'}
        ready={model.look === 'ready'}
        halo={!model.lightWindow}
        accessibilitySelected={model.selected}
        accessibilityValueText={windowValue ?? text.bulbValue}
        accessibilityTapHint={text.accessibilityHint}
        isScanning={model.pending}
        writing={model.writing}
        onPress={onPress}
        onLongPress={hold ? onLongPress : undefined}
        longPressHaptic={false}
        longPressActionLabel={text.longPressActionLabel}
        accessibilityLabel={text.bulbAccessibilityLabel}
        haptic="none"
        size={SIZES.lg.icon}
        containerSize={SIZES.lg.dim}
      />
      {model.lightWindow ? <WallWindowRing size={SIZES.lg.dim} /> : null}
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
