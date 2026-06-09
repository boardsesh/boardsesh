import { useCallback, useEffect, useMemo, useRef } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import BottomSheet from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { BoardName, HoldFilterEntry, HoldFilterMode, HoldFilterType } from '@boardsesh/shared-schema';
import { buildHoldFilterOptions } from '@boardsesh/climb-filters';
import { Sheet } from '../Sheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { SegmentedControl } from '../SegmentedControl';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';

type HoldFilterPickerProps = {
  /** The hold being edited, or null when the picker is closed. */
  holdId: number | null;
  boardName: BoardName;
  /** Current filter entry for the active hold. */
  entry: HoldFilterEntry;
  applyMode: HoldFilterMode;
  onApplyModeChange: (mode: HoldFilterMode) => void;
  /** Toggle one type's filter on the active hold (the picker owns the cycle). */
  onToggleType: (type: HoldFilterType) => void;
  onClear: () => void;
  onClose: () => void;
};

/**
 * Per-hold hold-type picker. Opened by tapping a hold on the interactive board.
 * Hosts an Include / Exclude apply-mode toggle plus one swatch per hold type
 * (board-filtered) and a Clear button — the native port of the web
 * `HoldTypePicker` search toolbar. Works in both UI variants: the chrome comes
 * from `Sheet` (glass / Material via theme) and `SegmentedControl`.
 */
export function HoldFilterPicker({
  holdId,
  boardName,
  entry,
  applyMode,
  onApplyModeChange,
  onToggleType,
  onClear,
  onClose,
}: HoldFilterPickerProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const sheetRef = useRef<BottomSheet>(null);

  useEffect(() => {
    if (holdId != null) {
      sheetRef.current?.snapToIndex(0);
    } else {
      sheetRef.current?.close();
    }
  }, [holdId]);

  const options = useMemo(() => buildHoldFilterOptions(boardName), [boardName]);
  const snapPoints = useMemo(() => ['42%'], []);

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

  const isEmpty = Object.keys(entry).length === 0;

  const handleSwatch = useCallback(
    (type: HoldFilterType) => {
      hapticSelection();
      onToggleType(type);
    },
    [onToggleType],
  );

  return (
    <Sheet ref={sheetRef} snapPoints={snapPoints} onClose={onClose} enablePanDownToClose fullWindowOverlay>
      <View style={styles.content}>
        <Text variant="headline" style={styles.title}>
          {t('mobile.holdFilter.pickerTitle')}
        </Text>

        <SegmentedControl
          options={applyModeOptions}
          selectedKey={applyMode}
          onSelect={onApplyModeChange}
          trackColor={systemColors.fill}
          accessibilityLabel={t('mobile.holdFilter.applyModeLabel')}
        />

        <View style={styles.grid}>
          {options.map((option) => {
            const mode = entry[option.type];
            const isActive = mode !== undefined;
            const excluded = mode === 'exclude';
            const accessibilityState = { selected: isActive };
            const stateSuffix = excluded
              ? t('mobile.holdFilter.excludedSuffix')
              : isActive
                ? t('mobile.holdFilter.includedSuffix')
                : '';
            const swatchColor = option.color;
            return (
              <Pressable
                key={option.type}
                onPress={() => handleSwatch(option.type)}
                accessibilityRole="button"
                accessibilityState={accessibilityState}
                accessibilityLabel={
                  stateSuffix ? `${typeLabels[option.type]}, ${stateSuffix}` : typeLabels[option.type]
                }
                style={[
                  styles.cell,
                  { backgroundColor: systemColors.fill },
                  isActive && { borderColor: swatchColor, borderWidth: 2 },
                ]}
              >
                <View
                  style={[
                    styles.swatch,
                    {
                      borderColor: swatchColor,
                      backgroundColor: excluded ? 'rgba(0,0,0,0.55)' : isActive ? swatchColor : 'transparent',
                    },
                  ]}
                >
                  {excluded ? <Icon name="close" size={12} color="#FFFFFF" /> : null}
                </View>
                <Text variant="subheadline" style={styles.cellLabel}>
                  {typeLabels[option.type]}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable
          onPress={() => {
            if (isEmpty) return;
            hapticSelection();
            onClear();
          }}
          disabled={isEmpty}
          accessibilityRole="button"
          accessibilityState={{ disabled: isEmpty }}
          accessibilityLabel={t('mobile.holdFilter.clearHold')}
          style={[styles.clearRow, isEmpty && styles.clearDisabled]}
        >
          <Icon name="ascent.attempt" size={16} color={systemColors.secondaryLabel} />
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {t('mobile.holdFilter.clearHold')}
          </Text>
        </Pressable>

        <Text variant="footnote" style={[styles.help, { color: systemColors.secondaryLabel }]}>
          {t('mobile.holdFilter.pickerHelp')}
        </Text>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    gap: spacing[3],
  },
  title: {
    textAlign: 'center',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
  cell: {
    // Grow to share the row evenly; the minWidth keeps ~3 per row while letting
    // a short final row (or a board with fewer swatches) stretch to fill.
    flexGrow: 1,
    flexBasis: '28%',
    minWidth: 96,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[2],
    borderRadius: borderRadius.md,
    borderColor: 'transparent',
    borderWidth: 2,
    minHeight: 48,
  },
  swatch: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellLabel: {
    fontWeight: '600',
    flexShrink: 1,
  },
  clearRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    paddingVertical: spacing[2],
    minHeight: 44,
  },
  clearDisabled: {
    opacity: 0.4,
  },
  help: {
    textAlign: 'center',
    paddingHorizontal: spacing[4],
  },
});
