import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { canAdjustBoardAngle } from '../../lib/boards/can-adjust-board-angle';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { LargeContentViewer } from '../LargeContentViewer';
import { Text } from '../Text';
import { BoardAnglePicker } from './BoardAnglePicker';
import { GlassToolbarAction } from './GlassActionToolbar';

/**
 * The one-tap "40°" toolbar button and its picker, on the Liquid Glass Climbs
 * and Discover chromes. Renders nothing for a fixed-angle board or none. Speaks
 * the angle, and shows it in the Large Content Viewer where the capped label
 * can't grow.
 */
export function AngleToolbarAction() {
  const { systemColors } = useTheme();
  const { t } = useTranslation('session');
  const { data: activeBoard } = useActiveBoard();
  if (!canAdjustBoardAngle(activeBoard)) return null;
  const spokenLabel = t('mobile.angleSelector.buttonAria', { angle: activeBoard.angle });

  return (
    <BoardAnglePicker>
      {(open) => (
        <GlassToolbarAction onPress={open} accessibilityLabel={spokenLabel}>
          <LargeContentViewer title={spokenLabel} onActivate={open}>
            <Text
              variant="caption1"
              numeric
              numberOfLines={1}
              maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
              style={[styles.angleText, { color: systemColors.label }]}
            >
              {activeBoard.angle}°
            </Text>
          </LargeContentViewer>
        </GlassToolbarAction>
      )}
    </BoardAnglePicker>
  );
}

const styles = StyleSheet.create({ angleText: { fontWeight: '700' } });
