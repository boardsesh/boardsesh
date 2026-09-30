import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { FONT } from './fonts';
import { Icon, type IconComponent } from './Icon';
import { X } from './icons';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, spacing } from './tokens';

type TextFieldProps = Omit<TextInputProps, 'style' | 'placeholderTextColor'> & {
  /** A mono label above the field. */
  label?: string;
  icon?: IconComponent;
  /** A clear button while there's text. */
  clearable?: boolean;
  hint?: string;
  error?: string | null;
  size?: 'sm' | 'md' | 'lg';
};

/** A hairline input that darkens to ink while focused. */
export function TextField({
  label,
  icon,
  clearable = false,
  hint,
  error,
  size = 'md',
  value,
  onChangeText,
  onFocus,
  onBlur,
  multiline,
  ...inputProps
}: TextFieldProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const height = size === 'lg' ? 48 : size === 'sm' ? 36 : 44;
  return (
    <View style={styles.wrapper}>
      {label ? <Text variant="label">{label}</Text> : null}
      <View
        style={[
          styles.field,
          multiline ? styles.multiline : { height },
          {
            backgroundColor: theme.bgSurface,
            borderColor: error ? theme.danger : focused ? theme.fg1 : theme.border2,
          },
        ]}
      >
        {icon ? <Icon icon={icon} size={18} color={theme.fg3} /> : null}
        <TextInput
          {...inputProps}
          value={value}
          onChangeText={onChangeText}
          multiline={multiline}
          accessibilityLabel={inputProps.accessibilityLabel ?? label ?? inputProps.placeholder}
          placeholderTextColor={theme.fg4}
          selectionColor={theme.fg1}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          style={[styles.input, { color: theme.fg1 }, multiline && styles.inputMultiline]}
        />
        {clearable && value ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear"
            hitSlop={spacing.sm}
            onPress={() => onChangeText?.('')}
            style={[styles.clear, { backgroundColor: theme.bgSurface3 }]}
          >
            <Icon icon={X} size={12} color={theme.fg2} strokeWidth={2.25} />
          </Pressable>
        ) : null}
      </View>
      {error || hint ? (
        <Text variant="caption" color={error ? theme.danger : theme.fg3}>
          {error || hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: spacing.sm, flexGrow: 1 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderRadius: radius.md,
    borderCurve: 'continuous',
  },
  multiline: { minHeight: 76, alignItems: 'flex-start', paddingVertical: 11 },
  input: { flex: 1, height: '100%', fontFamily: FONT.sans, fontSize: 15 },
  inputMultiline: { minHeight: 52, textAlignVertical: 'top' },
  clear: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
});
