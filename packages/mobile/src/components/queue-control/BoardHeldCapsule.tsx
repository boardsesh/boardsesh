// "You have the board": the Climbs header's status capsule while this climber
// holds the board (Liquid Glass only). It takes the slot the "On the wall"
// capsule uses, which shows only when the wall lights a climb other than yours,
// so the two never compete. The tab-bar accessory platter says the same thing
// with a mark on its thumbnail; this is the words for it, at the top of the list
// where a collapsed platter has no room for the bulb.
//
// Lit LEDs read amber with a lit bulb. A board with no lights reads in the brand
// tone with a pin and "You have the wall": amber only ever means the LEDs are on.
// The tap opens the Bluetooth controls sheet (Re-light / Turn off / Disconnect),
// so it is a button only while this device holds the radio link; a virtual hold
// on a board with no lights has nothing to control and reads as text.

import { memo, useCallback } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { useBleControlSheet } from '../../providers/ble-control-sheet-provider';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { hapticLight } from '../../lib/haptics';
import { LargeContentViewer } from '../LargeContentViewer';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { HeaderStatusCapsule, useHeaderCapsuleCompact } from './HeaderStatusCapsule';

const CAPSULE_GLYPH_SIZE = 16;

type BoardHeldCapsuleProps = {
  /** The board has no LED light kit: a pin and the brand tone, never amber. */
  ledless: boolean;
  /** This device holds the radio link, so the controls sheet has something to control. */
  canOpenControls: boolean;
};

function BoardHeldCapsuleImpl({ ledless, canOpenControls }: BoardHeldCapsuleProps) {
  const { t } = useTranslation('settings');
  const { systemColors, brandColors } = useTheme();
  const { open: openControls } = useBleControlSheet();
  const compact = useHeaderCapsuleCompact();

  const toneColor = ledless ? brandColors.primary : brandColors.warning;
  const label = t(ledless ? 'ble.barControl.wallHeldLabel' : 'ble.barControl.youHaveBoard');

  const handlePress = useCallback(() => {
    hapticLight();
    openControls({ surface: 'header_pill' });
  }, [openControls]);
  const onPress = canOpenControls ? handlePress : undefined;

  return (
    <HeaderStatusCapsule
      tintColor={toneColor}
      entryKey={ledless ? 'wall-held' : 'board-held'}
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityHint={onPress ? t('ble.barControl.openControlsHint') : undefined}
      compact={compact}
      testID="board-held-capsule"
    >
      {compact ? null : (
        <Icon
          maxFontSizeMultiplier={1}
          name={ledless ? 'pin.fill' : 'lightbulb.fill'}
          size={CAPSULE_GLYPH_SIZE}
          color={toneColor}
        />
      )}
      <LargeContentViewer title={label} onActivate={onPress} style={styles.labelViewer}>
        <Text
          variant="caption1"
          color={systemColors.label}
          numberOfLines={1}
          ellipsizeMode="tail"
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={styles.label}
        >
          {label}
        </Text>
      </LargeContentViewer>
    </HeaderStatusCapsule>
  );
}

export const BoardHeldCapsule = memo(BoardHeldCapsuleImpl);

const styles = StyleSheet.create({
  labelViewer: {
    // A flex:1 label has zero intrinsic width in a UIKit navigation title view.
    flexShrink: 1,
    minWidth: 0,
  },
  label: {
    flexShrink: 1,
    minWidth: 0,
    fontWeight: '600',
  },
});
