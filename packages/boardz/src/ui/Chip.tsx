import { Pressable, StyleSheet } from 'react-native';
import { FONT } from './fonts';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius } from './tokens';

type ChipProps = {
  label: string;
  /** A mono figure after the label. */
  count?: string | null;
  selected?: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
};

/** A pill to pick one of a few things: hairline when off, filled with ink when picked. */
export function Chip({ label, count, selected = false, onPress, accessibilityLabel }: ChipProps) {
  const theme = useTheme();
  const foreground = selected ? theme.fgOnAccent : theme.fg2;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        selected
          ? { backgroundColor: theme.accent, borderColor: theme.accent }
          : { borderColor: theme.border2, backgroundColor: pressed ? theme.bgSurface3 : 'transparent' },
      ]}
    >
      <Text color={foreground} numberOfLines={1} style={styles.label}>
        {label}
      </Text>
      {count ? (
        <Text variant="mono" color={foreground} style={styles.count}>
          {count}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    height: 36,
    paddingHorizontal: 12,
    borderRadius: radius.tag,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  label: { fontFamily: FONT.sansMedium, fontSize: 13, lineHeight: 16 },
  count: { fontSize: 11, opacity: 0.65 },
});
