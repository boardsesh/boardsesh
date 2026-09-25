import { View, StyleSheet } from 'react-native';
import {
  separatorInsetForDensity,
  thumbnailSizeForDensity,
  type ClimbListDensity,
} from './climb-list-thumbnail-metrics';
import { useTheme } from '../providers/theme-provider';
import { borderRadius, spacing } from '../theme/tokens';

export function ClimbListRowSkeleton({ density = 'default' }: { density?: ClimbListDensity }) {
  const { systemColors } = useTheme();
  const blockColor = systemColors.fill;

  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="climb-list-row-skeleton">
      <View style={[styles.contentRow, { backgroundColor: systemColors.background }]}>
        <View style={[styles.thumbnail, thumbnailSizeForDensity(density), { backgroundColor: blockColor }]} />
        <View style={styles.centerColumn}>
          <View style={[styles.titleBlock, { backgroundColor: blockColor }]} />
          {density !== 'compact' ? <View style={[styles.subtitleBlock, { backgroundColor: blockColor }]} /> : null}
        </View>
        <View style={[styles.gradeBlock, { backgroundColor: blockColor }]} />
      </View>
      <View
        style={[
          styles.separator,
          { marginLeft: separatorInsetForDensity(density), backgroundColor: systemColors.separator },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[2],
    gap: spacing[3],
  },
  thumbnail: {
    borderRadius: borderRadius.md,
    opacity: 0.55,
  },
  centerColumn: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: 8,
  },
  titleBlock: {
    width: '70%',
    height: 18,
    borderRadius: borderRadius.full,
    opacity: 0.55,
  },
  subtitleBlock: {
    width: '46%',
    height: 12,
    borderRadius: borderRadius.full,
    opacity: 0.4,
  },
  gradeBlock: {
    width: 34,
    height: 20,
    borderRadius: borderRadius.full,
    opacity: 0.5,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
  },
});
