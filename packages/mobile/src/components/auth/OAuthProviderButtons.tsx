import { opacity } from '../../theme/tokens';
import { Text } from '../Text';
import { useTypographyStyles, type TypographyScale } from '../../hooks/use-typography-styles';
import { PressableSurface } from '../PressableSurface';
import * as AppleAuthentication from 'expo-apple-authentication';
import { Platform, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { isGoogleSignInConfigured } from '../../lib/auth';
import { useTheme } from '../../providers/theme-provider';
import { GoogleLogo, googleButtonPalette } from './GoogleLogo';
import type { OAuthProviderAvailability, OAuthProviderButtonsProps } from './OAuthProviderButtons.types';

export type { OAuthProvider } from './OAuthProviderButtons.types';

const PROVIDER_BUTTON_MIN_HEIGHT = 50;

export function useOAuthProviders(): OAuthProviderAvailability {
  return {
    apple: Platform.OS === 'ios',
    google: isGoogleSignInConfigured(),
    loading: false,
    error: false,
    retry: () => undefined,
  };
}

/**
 * "Continue with Apple" then "Continue with Google": one pair for new and
 * returning climbers alike, since both providers find or create the account.
 * Apple stays the system button, which App Review expects and which labels and
 * localises itself. Google is a custom button in Google's branding colours
 * because the SDK's `GoogleSigninButton` can only say "Sign in"; the sign-in
 * itself still runs through the Google SDK. The web implementation lives in
 * OAuthProviderButtons.web.tsx.
 */
export function OAuthProviderButtons({ disabled, onSignIn, providers }: OAuthProviderButtonsProps) {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('auth');
  const theme = useTheme();
  const isDark = theme.colorScheme === 'dark';
  const googleColors = googleButtonPalette(theme.colorScheme);
  const cornerRadius = theme.radii.button;

  return (
    <View style={styles.buttons}>
      {providers.apple ? (
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
          buttonStyle={
            isDark
              ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
              : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
          }
          cornerRadius={cornerRadius}
          style={[styles.providerButton, disabled ? styles.disabled : undefined]}
          onPress={() => {
            if (!disabled) onSignIn('apple');
          }}
        />
      ) : null}
      {providers.google ? (
        <PressableSurface
          testID="auth-google-button"
          accessibilityRole="button"
          accessibilityLabel={t('login.providers.google')}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => onSignIn('google')}
          style={({ pressed }) => [
            styles.providerButton,
            styles.googleButton,
            { backgroundColor: googleColors.background, borderColor: googleColors.border, borderRadius: cornerRadius },
            disabled ? styles.disabled : undefined,
            pressed ? styles.pressed : undefined,
          ]}
        >
          <GoogleLogo />
          <Text style={[styles.googleLabel, { color: googleColors.label }]}>{t('login.providers.google')}</Text>
        </PressableSurface>
      ) : null}
    </View>
  );
}

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    buttons: { gap: 12 },
    // The Apple button is a native view and needs explicit dimensions or it
    // renders nothing. Google's minimum matches it, and grows for larger text.
    providerButton: { width: '100%', height: PROVIDER_BUTTON_MIN_HEIGHT },
    googleButton: {
      height: 'auto',
      minHeight: PROVIDER_BUTTON_MIN_HEIGHT,
      borderWidth: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    googleLabel: { fontSize: textStyles.body.fontSize, fontWeight: '600', flexShrink: 1, textAlign: 'center' },
    disabled: { opacity: opacity.disabled },
    pressed: { opacity: 0.8 },
  });
