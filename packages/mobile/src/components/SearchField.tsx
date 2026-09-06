import { forwardRef, type ComponentType } from 'react';
import { Pressable, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { Icon } from './Icon';
import { iosSystemColors } from '../theme/ios-colors';
import { spacing } from '../theme/tokens';
import { useTheme } from '../providers/theme-provider';

type SearchFieldProps = {
  value: string;
  onChangeText: (value: string) => void;
  /**
   * Caller-supplied, and the whole reason this is shared: the two screens using it
   * translate from different i18n namespaces.
   */
  placeholder: string;
  clearAccessibilityLabel: string;
  /**
   * Swap the input host. Callers inside a bottom sheet pass `BottomSheetTextInput`,
   * which the sheet needs in order to keep the keyboard and the sheet in step.
   */
  inputComponent?: ComponentType<TextInputProps>;
  autoFocus?: boolean;
  onSubmitEditing?: () => void;
};

/**
 * The app's plain search field: a filled capsule with a magnifier, an input, and a
 * clear button that appears once there is something to clear.
 *
 * Not `SearchHeader` — that one is the climb list's Liquid Glass capsule and owns
 * focus choreography and recent-search behaviour that a simple filter does not want.
 */
export const SearchField = forwardRef<TextInput, SearchFieldProps>(function SearchField(
  { value, onChangeText, placeholder, clearAccessibilityLabel, inputComponent, autoFocus, onSubmitEditing },
  ref,
) {
  const { systemColors } = useTheme();
  // Cast so `ref` + `autoFocus` type-check: the default TextInput and the
  // BottomSheetTextInput callers both forward a TextInput instance at runtime.
  const Input = (inputComponent ?? TextInput) as typeof TextInput;

  return (
    <View style={[styles.searchField, { backgroundColor: systemColors.fill }]}>
      <Icon name="search" size={18} color={systemColors.secondaryLabel} />
      <Input
        ref={ref}
        autoFocus={autoFocus}
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmitEditing}
        placeholder={placeholder}
        placeholderTextColor={iosSystemColors.systemGray}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={placeholder}
        style={[styles.searchInput, { color: systemColors.label }]}
      />
      {value.length > 0 ? (
        <Pressable
          onPress={() => onChangeText('')}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={clearAccessibilityLabel}
          style={styles.clearButton}
        >
          <Icon name="close" size={16} color={systemColors.secondaryLabel} />
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 42,
    borderRadius: 10,
    paddingHorizontal: spacing[3],
  },
  searchInput: {
    flex: 1,
    fontSize: 17,
    paddingVertical: 0,
  },
  clearButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -spacing[3],
  },
});
