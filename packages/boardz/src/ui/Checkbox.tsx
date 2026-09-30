import { Pressable, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Icon } from './Icon';
import { Check } from './icons';
import { Text } from './Text';
import { useTheme } from './theme';
import { spacing } from './tokens';

type CheckboxProps = {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
};

export function Checkbox({ label, description, checked, onChange, disabled = false }: CheckboxProps) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={() => {
        void Haptics.selectionAsync();
        onChange(!checked);
      }}
      style={[styles.row, disabled && styles.disabled]}
    >
      <View
        style={[
          styles.box,
          checked
            ? { backgroundColor: theme.accent }
            : { borderWidth: 1.5, borderColor: theme.borderStrong, backgroundColor: 'transparent' },
        ]}
      >
        {checked ? <Icon icon={Check} size={14} color={theme.fgOnAccent} strokeWidth={2.75} /> : null}
      </View>
      <View style={styles.copy}>
        <Text>{label}</Text>
        {description ? (
          <Text variant="small" tone="tertiary">
            {description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, minHeight: 24, paddingVertical: 2 },
  disabled: { opacity: 0.45 },
  box: { width: 20, height: 20, marginTop: 1, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, gap: 2 },
});
