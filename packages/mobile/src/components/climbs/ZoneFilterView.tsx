import type { ComponentProps } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { ActivityIndicator } from '../ActivityIndicator';
import { InteractiveFilterBoard } from '../search/InteractiveFilterBoard';
import { GlassSurface } from '../GlassSurface';
import { SegmentedControl } from '../SegmentedControl';
import { Button } from '../Button';
import { Text } from '../Text';
import { spacing } from '../../theme/tokens';
import type { ZoneMatchMode } from '@boardsesh/shared-schema';

export type ZoneFilterViewProps = {
  board: ComponentProps<typeof InteractiveFilterBoard> | null;
  zoneActive: boolean;
  zoneMode: ZoneMatchMode;
  modeOptions: { key: ZoneMatchMode; label: string }[];
  onModeChange: (mode: ZoneMatchMode) => void;
  onClear: () => void;
  onEnable: () => void;
  bottomInset: number;
};
export function ZoneFilterView({
  board,
  zoneActive,
  zoneMode,
  modeOptions,
  onModeChange,
  onClear,
  onEnable,
  bottomInset,
}: ZoneFilterViewProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  if (!board)
    return (
      <View style={[styles.loading, { backgroundColor: systemColors.background }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  return (
    <View style={[styles.container, { backgroundColor: systemColors.background }]}>
      <View style={styles.boardSection}>
        <InteractiveFilterBoard {...board} />
      </View>

      {zoneActive ? (
        <GlassSurface
          glassEffectStyle="regular"
          fallbackColor={systemColors.elevatedSurface}
          borderRadius={16}
          style={styles.modeIsland}
        >
          <SegmentedControl
            options={modeOptions}
            selectedKey={zoneMode}
            onSelect={onModeChange}
            trackColor={systemColors.fill}
            accessibilityLabel={t('mobile.zoneFilter.modeLabel')}
          />
          <Button
            title={t('mobile.zoneFilter.clearZone')}
            onPress={onClear}
            variant="outlined"
            size="small"
            over="glass"
            style={styles.clearButton}
          />
        </GlassSurface>
      ) : (
        <View style={styles.enableRow}>
          <Button title={t('mobile.zoneFilter.enable')} onPress={onEnable} variant="filled" size="medium" />
        </View>
      )}

      <View style={[styles.footer, { paddingBottom: bottomInset + spacing[3] }]}>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.footerText}>
          {zoneActive ? t('mobile.zoneFilter.activeHint') : t('mobile.zoneFilter.hint')}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boardSection: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeIsland: {
    marginHorizontal: spacing[4],
    padding: spacing[3],
    gap: spacing[2],
  },
  clearButton: {
    alignSelf: 'center',
  },
  enableRow: {
    paddingHorizontal: spacing[4],
    alignItems: 'center',
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    alignItems: 'center',
  },
  footerText: {
    textAlign: 'center',
  },
});
