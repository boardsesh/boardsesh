import * as AppleAuthentication from 'expo-apple-authentication';
import { GoogleSigninButton } from '@react-native-google-signin/google-signin';
import { Platform, StyleSheet, View } from 'react-native';
import { isGoogleSignInConfigured } from '../../lib/auth';
import { useTheme } from '../../providers/theme-provider';
import type { OAuthProviderAvailability, OAuthProviderButtonsProps } from './OAuthProviderButtons.types';

export type { OAuthProvider } from './OAuthProviderButtons.types';

export function useOAuthProviders(): OAuthProviderAvailability {
  return {
    apple: Platform.OS === 'ios',
    google: isGoogleSignInConfigured(),
    loading: false,
  };
}

/**
 * Native provider controls remain the SDK-owned buttons required by Apple and
 * Google. The web implementation lives in OAuthProviderButtons.web.tsx.
 */
export function OAuthProviderButtons({ disabled, isRegistration, onSignIn, providers }: OAuthProviderButtonsProps) {
  const theme = useTheme();
  const isDark = theme.colorScheme === 'dark';

  return (
    <View style={styles.buttons}>
      {providers.apple ? (
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={
            isRegistration
              ? AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP
              : AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN
          }
          buttonStyle={
            isDark
              ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
              : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
          }
          cornerRadius={12}
          style={[styles.providerButton, disabled ? styles.disabled : undefined]}
          onPress={() => onSignIn('apple')}
        />
      ) : null}
      {providers.google ? (
        <GoogleSigninButton
          size={GoogleSigninButton.Size.Wide}
          color={isDark ? GoogleSigninButton.Color.Dark : GoogleSigninButton.Color.Light}
          disabled={disabled}
          style={styles.providerButton}
          onPress={() => onSignIn('google')}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  buttons: { gap: 12 },
  // Native SDK buttons need explicit dimensions or they render nothing.
  providerButton: { width: '100%', height: 50 },
  disabled: { opacity: 0.5 },
});
