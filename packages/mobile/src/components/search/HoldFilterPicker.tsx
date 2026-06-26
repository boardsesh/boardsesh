import { useCallback, useMemo } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { BoardName, HoldFilterMode, HoldFilterType } from '@boardsesh/shared-schema';
import { buildHoldFilterOptions } from '@boardsesh/climb-filters';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { SegmentedControl } from '../SegmentedControl';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection } from '../../lib/haptics';
import { useHoldColorOverrides, type HoldMarkerShape } from '../../lib/hold-color-overrides';
import { spacing, borderRadius } from '../../theme/tokens';
import { HoldMarkerShapeSvg } from '../board-renderer/HoldMarkerShape';
import { getHoldFilterTypeShape } from './hold-filter-visuals';

type HoldFilterPickerProps = {
  boardName: BoardName;
  /** The active brush: the hold type tapping a hold will apply. */
  selectedType: HoldFilterType;
  onSelectType: (type: HoldFilterType) => void;
  /** Whether tapping a hold marks the brush type as included or excluded. */
  applyMode: HoldFilterMode;
  onApplyModeChange: (mode: HoldFilterMode) => void;
};

/**
 * Hold-type brush selector, docked below the board — the same paint-brush model
 * as the create-climb action bar: pick an Include / Exclude mode and a hold-type
 * chip, then tap holds on the board to stamp that type onto them (tapping a hold
 * that already carries the brush removes it). The selected chip is highlighted
 * and previews the current mode (an X overlay while excluding).
 *
 * This is NOT a stacked sub-sheet: a third `BottomSheetModal` over the 95% board
 * sheet would not reliably surface, so the controls live inline in the sheet.
 */
export function HoldFilterPicker({
  boardName,
  selectedType,
  onSelectType,
  applyMode,
  onApplyModeChange,
}: HoldFilterPickerProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const {
    overrides: holdColorOverrides,
    shapes: holdShapeOverrides,
    brushThickness,
    shapeSize,
  } = useHoldColorOverrides();

  const options = useMemo(() => buildHoldFilterOptions(boardName, holdColorOverrides), [boardName, holdColorOverrides]);
  const shapeByType = useMemo(() => {
    const map = new Map<HoldFilterType, HoldMarkerShape>();
    for (const option of options) {
      map.set(option.type, getHoldFilterTypeShape(option.type, holdShapeOverrides));
    }
    return map;
  }, [options, holdShapeOverrides]);

  const typeLabels = useMemo<Record<HoldFilterType, string>>(
    () => ({
      STARTING: t('mobile.holdFilter.type.starting'),
      HAND: t('mobile.holdFilter.type.hand'),
      FINISH: t('mobile.holdFilter.type.finish'),
      FOOT: t('mobile.holdFilter.type.foot'),
      ANY: t('mobile.holdFilter.type.any'),
    }),
    [t],
  );

  const applyModeOptions = useMemo(
    () => [
      { key: 'include' as const, label: t('mobile.holdFilter.include') },
      { key: 'exclude' as const, label: t('mobile.holdFilter.exclude') },
    ],
    [t],
  );

  const handleSelect = useCallback(
    (type: HoldFilterType) => {
      hapticSelection();
      onSelectType(type);
    },
    [onSelectType],
  );

  return (
    <View
      style={[styles.section, { borderTopColor: systemColors.separator, paddingBottom: insets.bottom + spacing[3] }]}
    >
      <SegmentedControl
        options={applyModeOptions}
        selectedKey={applyMode}
        onSelect={onApplyModeChange}
        trackColor={systemColors.fill}
        accessibilityLabel={t('mobile.holdFilter.applyModeLabel')}
      />

      <View style={styles.chipRow}>
        {options.map((option) => {
          const selected = option.type === selectedType;
          const excluded = selected && applyMode === 'exclude';
          const stateSuffix = excluded
            ? t('mobile.holdFilter.excludedSuffix')
            : selected
              ? t('mobile.holdFilter.includedSuffix')
              : '';
          const swatchColor = option.color;
          const swatchShape = shapeByType.get(option.type) ?? 'circle';
          const markerDiameter = 22 * shapeSize;
          const markerStrokeWidth = Math.max(2, 2 * brushThickness);
          return (
            <Pressable
              key={option.type}
              onPress={() => handleSelect(option.type)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={stateSuffix ? `${typeLabels[option.type]}, ${stateSuffix}` : typeLabels[option.type]}
              style={[
                styles.chip,
                { backgroundColor: systemColors.fill },
                selected && { borderColor: swatchColor, borderWidth: 2 },
              ]}
            >
              <View style={styles.chipSwatch}>
                <HoldMarkerShapeSvg
                  shape={swatchShape}
                  color={excluded ? '#000000' : swatchColor}
                  diameter={markerDiameter}
                  strokeWidth={excluded ? 0 : markerStrokeWidth}
                  fillOpacity={excluded ? 0.55 : selected ? 0.32 : 0}
                  equalArea={false}
                />
                {excluded ? (
                  <View style={styles.excludeIcon}>
                    <Icon name="close" size={12} color="#FFFFFF" />
                  </View>
                ) : null}
              </View>
              <Text variant="caption1" style={styles.chipLabel} numberOfLines={1}>
                {typeLabels[option.type]}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text variant="footnote" style={[styles.hint, { color: systemColors.secondaryLabel }]}>
        {t('mobile.holdFilter.hint')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    gap: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    // borderTopColor applied inline from systemColors.separator (scheme-aware).
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing[2],
  },
  chip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[1],
    borderRadius: borderRadius.md,
    borderColor: 'transparent',
    borderWidth: 2,
    minHeight: 64,
  },
  chipSwatch: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  excludeIcon: {
    position: 'absolute',
  },
  chipLabel: {
    fontWeight: '600',
  },
  hint: {
    textAlign: 'center',
    paddingHorizontal: spacing[4],
  },
});
