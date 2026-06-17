import { Pressable, StyleSheet, View, type ColorValue } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/queue';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useTheme } from '../../providers/theme-provider';
import { useDrawerHost, type BoardConfig } from '../../providers/drawer-host-provider';
import { spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { AccessoryClimbThumbnail } from './AccessoryClimbThumbnail';
import { useAccessoryClimbTap } from './use-accessory-climb-tap';
import { LogAscentToolbarButton } from './LogAscentToolbarButton';

type AccessoryPlacement = 'regular' | 'inline';

type NativeAccessoryClimbRowProps = {
  climb: Climb;
  placement: AccessoryPlacement;
  width: number;
};

const ACCESSORY_LEADING_INSET = spacing[1];
const ACCESSORY_TRAILING_INSET = spacing[3];

type ClimbLabelProps = {
  climb: Climb;
  labelColor: ColorValue;
  formattedGrade: string | null;
  showThumbnail: boolean;
  boardConfig: BoardConfig | null;
};

function ClimbLabel({ climb, labelColor, formattedGrade, showThumbnail, boardConfig }: ClimbLabelProps) {
  return (
    <View style={styles.labelInner}>
      {showThumbnail ? <AccessoryClimbThumbnail climb={climb} boardConfig={boardConfig} /> : null}
      <Text
        variant="subheadline"
        color={labelColor}
        numberOfLines={1}
        ellipsizeMode="tail"
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.name}
      >
        {climb.name}
      </Text>
      {formattedGrade ? (
        <Text
          variant="subheadline"
          color={labelColor}
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={styles.gradeText}
        >
          {formattedGrade}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Content for the iOS 26 tab-bar bottom accessory (Liquid Glass variant only).
 * UIKit supplies the glass platter, so this stays bare: current climb + tick. The
 * displayed climb is resolved once by {@link QueueBottomAccessory} and passed in,
 * so this component never re-gates (a second gate could blank the live platter for
 * a frame, which UIKit snapshotted as doubled text). Tap-to-open is shared with
 * the floating capsule via useAccessoryClimbTap. Its plain grade + board thumbnail
 * are tuned for the platter, so they intentionally differ from the floating
 * capsule's colorized grade.
 */
export function NativeAccessoryClimbRow({ climb, placement, width }: NativeAccessoryClimbRowProps) {
  const { t } = useTranslation('common');
  const { boardConfig } = useDrawerHost();
  const { systemColors } = useTheme();
  const { formatGrade } = useGradeFormat();
  const { openGesture, dismiss, canDismiss } = useAccessoryClimbTap();

  const showThumbnail = placement === 'regular' && boardConfig !== null;
  const rowHeight = placement === 'inline' ? glassSize.inline : glassSize.standard;
  const currentFormattedGrade = formatGrade(climb.difficulty);

  return (
    <View style={[styles.row, { width, height: rowHeight }]}>
      <GestureDetector gesture={openGesture}>
        <View style={styles.tapClip} accessibilityRole="button" accessibilityLabel={climb.name}>
          <View style={styles.labelSlot}>
            <ClimbLabel
              climb={climb}
              labelColor={systemColors.label}
              formattedGrade={currentFormattedGrade}
              showThumbnail={showThumbnail}
              boardConfig={boardConfig}
            />
          </View>
        </View>
      </GestureDetector>
      {canDismiss ? (
        <Pressable
          onPress={dismiss}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.accessoryBar.hideControlAria')}
          accessibilityHint={t('mobile.accessoryBar.hideControlHint')}
          hitSlop={spacing[1]}
          style={[styles.hideSlot, { width: glassSize.inline, height: rowHeight }]}
        >
          <Icon name="chevron.down" size={20} color={systemColors.secondaryLabel} />
        </Pressable>
      ) : null}
      <View style={[styles.tickSlot, { width: glassSize.inline, height: rowHeight }]}>
        <LogAscentToolbarButton climb={climb} size={glassSize.inline} iconSize={24} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: ACCESSORY_LEADING_INSET,
    paddingRight: ACCESSORY_TRAILING_INSET,
  },
  tapClip: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  labelSlot: {
    justifyContent: 'center',
    height: '100%',
  },
  labelInner: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    gap: spacing[2],
    paddingLeft: spacing[2],
    paddingRight: spacing[1],
  },
  name: {
    flex: 1,
    minWidth: 0,
    fontWeight: '500',
  },
  gradeText: {
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
    minWidth: spacing[10],
    textAlign: 'right',
  },
  // Separated from the tick by a gap so the hide control is never mistaken for —
  // or fat-fingered into — logging an ascent.
  hideSlot: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginRight: spacing[1],
  },
  tickSlot: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
});
