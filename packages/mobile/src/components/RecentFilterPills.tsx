import { useCallback } from 'react';
import { View, ScrollView, Pressable, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { Text } from './Text';
import { Icon } from './Icon';
import type { RecentFilter } from '../lib/recent-filter-store';
import { getFilterKey } from '../lib/recent-filter-store';
import type { ClimbFilters } from './ClimbFilterSheet';
import { iosSystemColors } from '../theme/ios-colors';
import { spacing } from '../theme/tokens';
import { springs } from '../theme/animations';
import { hapticSelection } from '../lib/haptics';
import { useTheme } from '../providers/theme-provider';

type RecentFilterPillsProps = {
  recentFilters: RecentFilter[];
  currentFilters: ClimbFilters;
  currentSearchText: string;
  onApply: (filters: ClimbFilters, searchText: string) => void;
  onClear: () => void;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function Pill({
  filter,
  isActive,
  onApply,
}: {
  filter: RecentFilter;
  isActive: boolean;
  onApply: (filters: ClimbFilters, searchText: string) => void;
}) {
  const { brandColors } = useTheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.95, springs.snappy);
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, springs.snappy);
  };

  const handlePress = useCallback(() => {
    hapticSelection();
    onApply(filter.filters, filter.searchText);
  }, [filter.filters, filter.searchText, onApply]);

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      accessibilityRole="button"
      accessibilityState={{ selected: isActive }}
      accessibilityLabel={filter.label}
      style={[
        animatedStyle,
        styles.pill,
        isActive
          ? { borderColor: brandColors.primary, backgroundColor: `${brandColors.primary}14` }
          : styles.pillInactive,
      ]}
    >
      <Icon name="history" size={14} color={isActive ? brandColors.primary : iosSystemColors.systemGray} />
      <Text
        variant="caption1"
        color={isActive ? brandColors.primary : undefined}
        numberOfLines={1}
        style={styles.pillLabel}
      >
        {filter.label}
      </Text>
    </AnimatedPressable>
  );
}

export function RecentFilterPills({
  recentFilters,
  currentFilters,
  currentSearchText,
  onApply,
  onClear,
}: RecentFilterPillsProps) {
  const { t } = useTranslation('climbs');
  const { brandColors } = useTheme();
  const currentKey = getFilterKey(currentFilters, currentSearchText);

  if (recentFilters.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text variant="footnote" style={styles.headerLabel}>
          {t('mobile.search.recentFilters')}
        </Text>
        <Pressable onPress={onClear} hitSlop={8} accessibilityRole="button">
          <Text variant="footnote" color={brandColors.primary}>
            {t('mobile.search.clearRecent')}
          </Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.pillList}
        keyboardShouldPersistTaps="handled"
      >
        {recentFilters.map((filter) => (
          <Pill
            key={filter.id}
            filter={filter}
            isActive={getFilterKey(filter.filters, filter.searchText) === currentKey}
            onApply={onApply}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: spacing[2],
    paddingBottom: spacing[3],
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    marginBottom: spacing[2],
  },
  headerLabel: {
    opacity: 0.5,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  pillList: {
    paddingHorizontal: spacing[4],
    gap: spacing[2],
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: 20,
    borderWidth: 1,
  },
  pillInactive: {
    borderColor: iosSystemColors.separator,
    backgroundColor: 'transparent',
  },
  pillLabel: {
    fontWeight: '500',
    maxWidth: 200,
  },
});
