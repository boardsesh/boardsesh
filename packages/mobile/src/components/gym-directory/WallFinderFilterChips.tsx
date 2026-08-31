import { useCallback, useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_BOARDS, formatBoardDisplayName } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { spacing } from '../../theme/tokens';
import { springs } from '../../theme/animations';
import { hapticSelection } from '../../lib/haptics';
import { useHasCompleteQuantumGeometryCatalog } from '../../lib/quantum-geometry-store';
import type { WallFinderLayoutOption, WallFinderSizeOption } from '../../lib/wall-finder-filter';
import { useTheme } from '../../providers/theme-provider';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * One outlined pill. Generic over what it represents (the multi-board toggle, a
 * board type, a layout, or a size) — the parent owns the meaning and the toggle.
 */
function Chip({
  label,
  active,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  const { brandColors, systemColors } = useTheme();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePress = useCallback(() => {
    hapticSelection();
    onPress();
  }, [onPress]);

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={() => {
        scale.value = withSpring(0.95, springs.snappy);
      }}
      onPressOut={() => {
        scale.value = withSpring(1, springs.snappy);
      }}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={accessibilityLabel ?? label}
      style={[
        animatedStyle,
        styles.chip,
        active
          ? { borderColor: brandColors.primary, backgroundColor: `${brandColors.primary}14` }
          : { borderColor: systemColors.separator },
      ]}
    >
      <Text variant="caption1" color={active ? brandColors.primary : undefined} style={styles.chipLabel}>
        {label}
      </Text>
    </AnimatedPressable>
  );
}

export type WallFinderFilterChipsProps = {
  /** Selected board types (multi-select OR). */
  selected: BoardName[];
  onToggle: (boardType: BoardName) => void;
  /** Restrict to gyms with two or more distinct board types. */
  multiBoardTypeOnly: boolean;
  onToggleMultiBoardType: () => void;
  /** Translated label for the multi-board-type chip (e.g. "2+ board types"). */
  multiBoardLabel: string;
  /** Layouts for the single selected board type — empty unless exactly one type is selected. */
  layoutOptions: WallFinderLayoutOption[];
  selectedLayoutIds: number[];
  onToggleLayout: (layoutId: number) => void;
  /** Sizes for the single selected layout — empty unless exactly one layout is selected. */
  sizeOptions: WallFinderSizeOption[];
  selectedSizeIds: number[];
  onToggleSize: (sizeIds: number[]) => void;
  onClear: () => void;
};

/**
 * The Wall Finder filter chip row: a horizontal-scroll header that narrows the
 * gym/board list. Nested reveal — board type → layout → size — so the row only
 * grows once a single choice in the tier above makes the next tier meaningful
 * (layouts are board-type-scoped, sizes are layout-scoped). A leading "2+ board
 * types" toggle and a trailing "Clear" bracket the row. Filtering is a data-layer
 * concern (the screen owns the selection), so it works identically whether or not
 * the map renders.
 */
export function WallFinderFilterChips({
  selected,
  onToggle,
  multiBoardTypeOnly,
  onToggleMultiBoardType,
  multiBoardLabel,
  layoutOptions,
  selectedLayoutIds,
  onToggleLayout,
  sizeOptions,
  selectedSizeIds,
  onToggleSize,
  onClear,
}: WallFinderFilterChipsProps) {
  const { t } = useTranslation('common');
  const { brandColors } = useTheme();
  const quantumCatalogReady = useHasCompleteQuantumGeometryCatalog();
  const availableBoardTypes = useMemo<BoardName[]>(
    () => (quantumCatalogReady ? [...SUPPORTED_BOARDS, 'quantum'] : [...SUPPORTED_BOARDS]),
    [quantumCatalogReady],
  );

  const hasActive =
    multiBoardTypeOnly || selected.length > 0 || selectedLayoutIds.length > 0 || selectedSizeIds.length > 0;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.list}
      keyboardShouldPersistTaps="handled"
    >
      <Chip label={multiBoardLabel} active={multiBoardTypeOnly} onPress={onToggleMultiBoardType} />

      {availableBoardTypes.map((boardType) => (
        // Brand product names — never translated.
        <Chip
          key={`type:${boardType}`}
          label={formatBoardDisplayName(boardType)}
          active={selected.includes(boardType)}
          onPress={() => onToggle(boardType)}
        />
      ))}

      {layoutOptions.map((layout) => (
        <Chip
          key={`layout:${layout.id}`}
          label={layout.label}
          active={selectedLayoutIds.includes(layout.id)}
          onPress={() => onToggleLayout(layout.id)}
        />
      ))}

      {sizeOptions.map((size) => {
        const active = size.sizeIds.length > 0 && size.sizeIds.every((id) => selectedSizeIds.includes(id));
        return (
          <Chip
            key={`size:${size.label}`}
            label={size.label}
            active={active}
            onPress={() => onToggleSize(size.sizeIds)}
          />
        );
      })}

      {hasActive ? (
        <Pressable onPress={onClear} hitSlop={8} accessibilityRole="button" style={styles.clear}>
          <Text variant="caption1" color={brandColors.primary} style={styles.chipLabel}>
            {t('actions.clear')}
          </Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: spacing[2],
    alignItems: 'center',
  },
  chip: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: 20,
    borderWidth: 1,
  },
  chipLabel: {
    fontWeight: '500',
  },
  clear: {
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[2],
  },
});
