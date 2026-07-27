import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import { webApiUrl } from '../../lib/env';
import { useTheme } from '../../providers/theme-provider';
import type { OAuthProviderAvailability, OAuthProviderButtonsProps } from './OAuthProviderButtons.types';

export type { OAuthProvider } from './OAuthProviderButtons.types';

type ProvidersConfigResponse = {
  apple?: unknown;
  google?: unknown;
};

const UNAVAILABLE_PROVIDERS: OAuthProviderAvailability = {
  apple: false,
  google: false,
  loading: false,
};

function parseProvidersConfig(response: ProvidersConfigResponse): OAuthProviderAvailability {
  return {
    apple: response.apple === true,
    google: response.google === true,
    loading: false,
  };
}

export function useOAuthProviders(): OAuthProviderAvailability {
  const [providers, setProviders] = useState<OAuthProviderAvailability>({
    ...UNAVAILABLE_PROVIDERS,
    loading: true,
  });

  useEffect(() => {
    const abortController = new AbortController();

    void fetch(webApiUrl('/api/auth/providers-config'), {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: abortController.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Provider discovery failed with ${response.status}`);
        return (await response.json()) as ProvidersConfigResponse;
      })
      .then((response) => setProviders(parseProvidersConfig(response)))
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        setProviders(UNAVAILABLE_PROVIDERS);
      });

    return () => abortController.abort();
  }, []);

  return providers;
}

function GoogleIcon() {
  return (
    <Svg viewBox="0 0 24 24" width={20} height={20} accessibilityElementsHidden>
      <Path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <Path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <Path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <Path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </Svg>
  );
}

function AppleIcon({ color }: { color: string }) {
  return (
    <Svg viewBox="0 0 24 24" width={20} height={20} accessibilityElementsHidden>
      <Path
        fill={color}
        d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"
      />
    </Svg>
  );
}

export function OAuthProviderButtons({ disabled, onSignIn, providers }: OAuthProviderButtonsProps) {
  const { t } = useTranslation('auth');
  const theme = useTheme();
  const appleBackground = theme.colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const appleForeground = theme.colorScheme === 'dark' ? '#000000' : '#FFFFFF';

  if (providers.loading) {
    return (
      <View style={styles.loadingButtons} accessibilityLabel={t('nativeStart.orContinueWith')}>
        <View style={[styles.loadingButton, { backgroundColor: theme.systemColors.fill }]} />
        <View style={[styles.loadingButton, { backgroundColor: theme.systemColors.fill }]} />
      </View>
    );
  }

  return (
    <View style={styles.buttons}>
      {providers.google ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('login.providers.google')}
          disabled={disabled}
          onPress={() => onSignIn('google')}
          style={({ pressed }) => [
            styles.providerButton,
            styles.googleButton,
            disabled ? styles.disabled : undefined,
            pressed ? styles.pressed : undefined,
          ]}
        >
          <GoogleIcon />
          <Text style={styles.googleLabel}>{t('login.providers.google')}</Text>
        </Pressable>
      ) : null}
      {providers.apple ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('login.providers.apple')}
          disabled={disabled}
          onPress={() => onSignIn('apple')}
          style={({ pressed }) => [
            styles.providerButton,
            { backgroundColor: appleBackground, borderColor: appleBackground },
            disabled ? styles.disabled : undefined,
            pressed ? styles.pressed : undefined,
          ]}
        >
          <AppleIcon color={appleForeground} />
          <Text style={[styles.appleLabel, { color: appleForeground }]}>{t('login.providers.apple')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  buttons: { gap: 12 },
  loadingButtons: { gap: 12, minHeight: 112 },
  providerButton: {
    width: '100%',
    height: 50,
    borderRadius: 4,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  googleButton: {
    backgroundColor: '#FFFFFF',
    borderColor: '#747775',
  },
  googleLabel: {
    color: '#1F1F1F',
    fontSize: 15,
    fontWeight: '600',
  },
  appleLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  loadingButton: {
    width: '100%',
    height: 50,
    borderRadius: 4,
    opacity: 0.45,
  },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
});
