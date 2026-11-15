import { memo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../../providers/theme-provider';
import { borderRadius, spacing } from '../../../theme/tokens';
import { resolveWallKioskBandColumns } from './wall-kiosk-type';
import type { WallKioskRegion } from './wall-kiosk-layout';
export type WallChromeRegionViewProps = {
  region: WallKioskRegion;
  bandWidth: number;
  stateStrip: ReactNode;
  identity: ReactNode;
  scrubber: ReactNode;
};
export const WallChromeRegionView = memo(function WallChromeRegionView({
  region,
  bandWidth,
  stateStrip,
  identity,
  scrubber,
}: WallChromeRegionViewProps) {
  const { systemColors } = useTheme();
  const bandColumns = region === 'band' ? resolveWallKioskBandColumns(bandWidth) : 1;
  const surface = [styles.surface, { backgroundColor: systemColors.elevatedSurface }];

  if (region === 'rail') {
    return (
      <View style={[surface, styles.rail]}>
        <View style={styles.railTop}>
          {stateStrip}
          {identity}
        </View>
        {scrubber}
      </View>
    );
  }

  if (bandColumns === 3) {
    return (
      <View style={[surface, styles.bandRow]}>
        <View style={styles.bandPrimaryThree}>{identity}</View>
        <View style={[styles.bandSeparator, { backgroundColor: systemColors.separator }]} />
        <View style={styles.bandStateThree}>{stateStrip}</View>
        <View style={[styles.bandSeparator, { backgroundColor: systemColors.separator }]} />
        <View style={styles.bandControlsThree}>{scrubber}</View>
      </View>
    );
  }

  if (bandColumns === 2) {
    return (
      <View style={[surface, styles.bandRow]}>
        <View style={styles.bandLeft}>
          {stateStrip}
          {identity}
        </View>
        <View style={[styles.bandSeparator, { backgroundColor: systemColors.separator }]} />
        <View style={styles.bandRight}>{scrubber}</View>
      </View>
    );
  }

  return (
    <View style={[surface, styles.bandStacked]}>
      {stateStrip}
      {identity}
      {scrubber}
    </View>
  );
});
const styles = StyleSheet.create({
  surface: {
    flex: 1,
    borderRadius: borderRadius.lg,
    padding: spacing[4],
    overflow: 'hidden',
  },
  rail: {
    flexDirection: 'column',
    justifyContent: 'space-between',
  },
  railTop: {
    gap: spacing[3],
  },
  bandRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing[4],
  },
  bandLeft: {
    flex: 0.55,
    gap: spacing[3],
    justifyContent: 'flex-start',
  },
  bandSeparator: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
  },
  bandRight: {
    flex: 0.45,
    justifyContent: 'center',
    gap: spacing[4],
  },
  bandPrimaryThree: {
    flex: 0.46,
    gap: spacing[3],
    justifyContent: 'flex-start',
  },
  bandStateThree: {
    flex: 0.26,
    gap: spacing[3],
    justifyContent: 'center',
  },
  bandControlsThree: {
    flex: 0.28,
    justifyContent: 'center',
  },
  bandStacked: {
    flexDirection: 'column',
    justifyContent: 'space-between',
    gap: spacing[3],
  },
  idleRoot: {
    gap: spacing[2],
  },
  idleName: {
    fontWeight: '700',
  },
  idleGrade: {
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
});
