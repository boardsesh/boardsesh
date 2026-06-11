import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { SegmentedControl } from '../SegmentedControl';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import type { SearchHeatmapMode } from './SearchHeatmapOverlay';

type HeatmapControlsProps = {
  available: boolean;
  enabled: boolean;
  loading: boolean;
  mode: SearchHeatmapMode;
  onEnabledChange: (enabled: boolean) => void;
  onModeChange: (mode: SearchHeatmapMode) => void;
};

export function HeatmapControls({
  available,
  enabled,
  loading,
  mode,
  onEnabledChange,
  onModeChange,
}: HeatmapControlsProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const modeOptions = useMemo(
    () => [
      { key: 'total' as const, label: t('mobile.heatmap.total') },
      { key: 'start' as const, label: t('mobile.heatmap.start') },
      { key: 'handsFeet' as const, label: t('mobile.heatmap.handsFeet') },
      { key: 'finish' as const, label: t('mobile.heatmap.finish') },
    ],
    [t],
  );

  if (!available) {
    return (
      <View style={styles.container}>
        <Button
          title={t('mobile.heatmap.unavailable')}
          onPress={() => undefined}
          variant="outlined"
          size="small"
          icon="flame"
          disabled
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Button
        title={loading ? t('mobile.heatmap.loading') : enabled ? t('mobile.heatmap.hide') : t('mobile.heatmap.show')}
        onPress={() => onEnabledChange(!enabled)}
        variant={enabled ? 'filled' : 'outlined'}
        size="small"
        icon="flame"
        loading={loading}
      />
      {enabled ? (
        <View style={styles.modeGroup}>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.modeLabel}>
            {t('mobile.heatmap.modeLabel')}
          </Text>
          <SegmentedControl
            options={modeOptions}
            selectedKey={mode}
            onSelect={onModeChange}
            textVariant="footnote"
            trackColor={systemColors.fill}
            accessibilityLabel={t('mobile.heatmap.modeLabel')}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    gap: spacing[2],
    alignItems: 'center',
  },
  modeGroup: {
    alignSelf: 'stretch',
    gap: spacing[1],
  },
  modeLabel: {
    textAlign: 'center',
  },
});
