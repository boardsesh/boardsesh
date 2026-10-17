import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { Text } from '../Text';
import { BoardAnglePicker } from './BoardAnglePicker';
import { GlassToolbarAction } from './GlassActionToolbar';

/** Discover and Record retain their direct angle button and shared picker. */
export function AngleToolbarAction() {
  const { systemColors } = useTheme();
  const { t } = useTranslation('session');
  const { data: activeBoard } = useActiveBoard();
  if (!activeBoard || activeBoard.isAngleAdjustable === false || activeBoard.angle == null) return null;

  return (
    <BoardAnglePicker>
      {(open) => (
        <GlassToolbarAction onPress={open} accessibilityLabel={t('mobile.angleSelector.title')}>
          <Text variant="caption1" style={[styles.angleText, { color: systemColors.label }]}>
            {activeBoard.angle}°
          </Text>
        </GlassToolbarAction>
      )}
    </BoardAnglePicker>
  );
}

const styles = StyleSheet.create({ angleText: { fontWeight: '700' } });
