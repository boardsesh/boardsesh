import { ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '../Text';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

type ScrollableTabsProps<Key extends string> = {
  options: { key: Key; label: string }[];
  selectedKey: Key;
  onSelect: (key: Key) => void;
  accessibilityLabel?: string;
};

/** Text-sized tabs grow and scroll rather than truncating five translated segments. */
export function ScrollableTabs<Key extends string>({
  options,
  selectedKey,
  onSelect,
  accessibilityLabel,
}: ScrollableTabsProps<Key>) {
  const { systemColors } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
    >
      <View style={styles.row}>
        {options.map((option) => (
          <PressableSurface
            key={option.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: selectedKey === option.key }}
            onPress={() => onSelect(option.key)}
            style={styles.tab}
            feedback="opacity"
          >
            <Text variant="subheadline" color={systemColors.label}>
              {option.label}
            </Text>
            <View
              style={[
                styles.indicator,
                { backgroundColor: selectedKey === option.key ? systemColors.accent : 'transparent' },
              ]}
            />
          </PressableSurface>
        ))}
      </View>
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  tab: { minHeight: 48, paddingHorizontal: spacing[3], paddingVertical: spacing[2], justifyContent: 'center' },
  indicator: { height: 3, alignSelf: 'stretch', marginTop: spacing[1] },
});
