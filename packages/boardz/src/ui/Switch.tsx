import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Text } from './Text';
import { useTheme } from './theme';
import { MIN_TAP_SIZE, spacing } from './tokens';

type SwitchProps = {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
};

/** A labelled on/off switch; the track fills with ink when on. */
export function Switch({ label, description, value, onValueChange, disabled = false }: SwitchProps) {
  const theme = useTheme();
  const offset = useRef(new Animated.Value(value ? 18 : 0)).current;

  useEffect(() => {
    Animated.timing(offset, { toValue: value ? 18 : 0, duration: 220, useNativeDriver: true }).start();
  }, [value, offset]);

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => {
        void Haptics.selectionAsync();
        onValueChange(!value);
      }}
      style={[styles.row, disabled && styles.disabled]}
    >
      <View style={styles.copy}>
        <Text>{label}</Text>
        {description ? (
          <Text variant="small" tone="tertiary">
            {description}
          </Text>
        ) : null}
      </View>
      <View style={[styles.track, { backgroundColor: value ? theme.accent : theme.border2 }]}>
        <Animated.View
          style={[
            styles.thumb,
            {
              backgroundColor: value ? theme.fgOnAccent : theme.switchThumb,
              transform: [{ translateX: offset }],
            },
          ]}
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: MIN_TAP_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  disabled: { opacity: 0.45 },
  copy: { flex: 1, gap: 2 },
  track: { width: 44, height: 26, borderRadius: 13, padding: 3 },
  thumb: {
    width: 20,
    height: 20,
    borderRadius: 10,
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 1,
    shadowOffset: { width: 0, height: 1 },
  },
});
