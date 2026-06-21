import { forwardRef, useState, type ComponentProps } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput as RNTextInput,
  View,
  type TextInputProps as RNTextInputProps,
} from 'react-native';
import { TextInput as PaperTextInput, HelperText } from 'react-native-paper';
import { Text } from './Text';
import { Icon } from './Icon';
import { useTheme } from '../providers/theme-provider';
import { selectByVariant } from '../theme/variants';
import { iosSystemColors } from '../theme/ios-colors';

// iOS systemRed — matches login.tsx's error text and is correct on the Liquid
// Glass branch (which only ever resolves on iOS hardware).
const GLASS_ERROR_COLOR = '#FF3B30';

type AuthTextInputProps = {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  /** Visible placeholder on the glass branch (Material uses the floating label). */
  placeholder?: string;
  /** Translated error message — renders inline and flips the field to its error state. */
  error?: string;
  /** Translated helper text shown when there's no error (e.g. a password rule). */
  hint?: string;
  /** When true, the field is a password: it masks input and shows a show/hide toggle. */
  secureTextEntry?: boolean;
  editable?: boolean;
  keyboardType?: RNTextInputProps['keyboardType'];
  autoCapitalize?: RNTextInputProps['autoCapitalize'];
  autoCorrect?: boolean;
  autoComplete?: RNTextInputProps['autoComplete'];
  textContentType?: RNTextInputProps['textContentType'];
  returnKeyType?: RNTextInputProps['returnKeyType'];
  passwordRules?: string;
  onSubmitEditing?: () => void;
  /** Defaults to `label` so VoiceOver/TalkBack always have a name. */
  accessibilityLabel?: string;
  /** Show-password / hide-password labels for the toggle (already translated). */
  showLabel?: string;
  hideLabel?: string;
  /** Native test identifier (used by Maestro screenshot flows). */
  testID?: string;
};

/**
 * A single auth field that renders the Apple-HIG white input on the Liquid Glass
 * variant and a Material 3 outlined Paper field on the Material variant — the
 * same internal branch-on-`theme.variant` pattern `Button` uses, so call sites
 * (login, register) stay identical across platforms. Password fields get a
 * show/hide toggle; errors/hints render inline per field.
 */
export const AuthTextInput = forwardRef<RNTextInput, AuthTextInputProps>(function AuthTextInput(
  {
    label,
    value,
    onChangeText,
    placeholder,
    error,
    hint,
    secureTextEntry = false,
    editable = true,
    keyboardType,
    autoCapitalize,
    autoCorrect,
    autoComplete,
    textContentType,
    returnKeyType,
    passwordRules,
    onSubmitEditing,
    accessibilityLabel,
    showLabel = 'Show password',
    hideLabel = 'Hide password',
    testID,
  },
  ref,
) {
  const theme = useTheme();
  const [revealed, setRevealed] = useState(false);
  const masked = secureTextEntry && !revealed;
  const a11yLabel = accessibilityLabel ?? label;

  // Shared native-input props so the two branches stay in lockstep.
  const sharedInputProps = {
    value,
    onChangeText,
    editable,
    keyboardType,
    autoCapitalize,
    autoCorrect,
    autoComplete,
    textContentType,
    returnKeyType,
    passwordRules,
    onSubmitEditing,
    secureTextEntry: masked,
    testID,
  } as const;

  const isMaterial = selectByVariant(theme.variant, { material: true, liquidGlass: false });
  if (isMaterial) {
    return (
      <View>
        <PaperTextInput
          // Paper forwards focus()/blur() to the native input; the ref shapes
          // differ structurally, so cast to the prop type Paper expects.
          ref={ref as unknown as ComponentProps<typeof PaperTextInput>['ref']}
          mode="outlined"
          label={label}
          placeholder={placeholder}
          error={Boolean(error)}
          accessibilityLabel={a11yLabel}
          right={
            secureTextEntry ? (
              <PaperTextInput.Icon
                icon={revealed ? 'eye-off-outline' : 'eye-outline'}
                onPress={() => setRevealed((prev) => !prev)}
                accessibilityLabel={revealed ? hideLabel : showLabel}
                forceTextInputFocus={false}
              />
            ) : undefined
          }
          {...sharedInputProps}
        />
        {error ? (
          <HelperText type="error" visible accessibilityLiveRegion="polite">
            {error}
          </HelperText>
        ) : hint ? (
          <HelperText type="info" visible>
            {hint}
          </HelperText>
        ) : null}
      </View>
    );
  }

  // Liquid Glass / iOS branch — login.tsx's white-in-dark-mode field, verbatim.
  const isDark = theme.colorScheme === 'dark';
  const inputBackground = isDark ? iosSystemColors.white : '#FFFFFF';
  const inputBorder = error ? GLASS_ERROR_COLOR : isDark ? 'rgba(60, 60, 67, 0.36)' : 'rgba(60, 60, 67, 0.18)';
  const inputTextColor = '#000000';
  const inputPlaceholderColor = 'rgba(60, 60, 67, 0.6)';

  return (
    <View>
      <View style={styles.glassInputWrap}>
        <RNTextInput
          ref={ref}
          style={[
            styles.glassInput,
            secureTextEntry && styles.glassInputWithToggle,
            // A hairline red is a weak error signal; thicken the errored border.
            error ? styles.glassInputErrored : null,
            { backgroundColor: inputBackground, borderColor: inputBorder, color: inputTextColor },
          ]}
          placeholder={placeholder}
          placeholderTextColor={inputPlaceholderColor}
          accessibilityLabel={a11yLabel}
          {...sharedInputProps}
        />
        {secureTextEntry ? (
          <Pressable
            onPress={() => setRevealed((prev) => !prev)}
            hitSlop={12}
            style={styles.glassToggle}
            accessibilityRole="button"
            accessibilityLabel={revealed ? hideLabel : showLabel}
            accessibilityState={{ selected: revealed }}
          >
            <Icon name={revealed ? 'visibility.off' : 'visibility'} size={20} color={inputPlaceholderColor} />
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <Text
          variant="footnote"
          style={[styles.glassError, { color: GLASS_ERROR_COLOR }]}
          accessibilityLiveRegion="polite"
        >
          {error}
        </Text>
      ) : hint ? (
        <Text variant="footnote" color={theme.systemColors.secondaryLabel} style={styles.glassHint}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  glassInputWrap: { position: 'relative', justifyContent: 'center' },
  glassInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 17,
  },
  // Leave room for the eye toggle so long values don't run under it.
  glassInputWithToggle: { paddingRight: 48 },
  glassInputErrored: { borderWidth: 1 },
  glassToggle: {
    position: 'absolute',
    right: 12,
    height: 44,
    width: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glassError: { marginTop: 4 },
  glassHint: { marginTop: 4 },
});
