import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import { webApiUrl } from '../../lib/env';
import { useTheme } from '../../providers/theme-provider';
import { GoogleLogo, googleButtonPalette } from './GoogleLogo';
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
  error: false,
  retry: () => undefined,
};

function parseProvidersConfig(response: ProvidersConfigResponse): OAuthProviderAvailability {
  return {
    apple: response.apple === true,
    google: response.google === true,
    loading: false,
    error: false,
    retry: () => undefined,
  };
}

export function useOAuthProviders(): OAuthProviderAvailability {
  const [requestVersion, setRequestVersion] = useState(0);
  const [providers, setProviders] = useState<OAuthProviderAvailability>({
    ...UNAVAILABLE_PROVIDERS,
    loading: true,
    retry: () => setRequestVersion((version) => version + 1),
  });

  useEffect(() => {
    const abortController = new AbortController();
    let disposed = false;
    const timeoutId = setTimeout(() => abortController.abort(), 8_000);
    const retry = () => setRequestVersion((version) => version + 1);
    setProviders({ ...UNAVAILABLE_PROVIDERS, loading: true, retry });

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
      .then((response) => {
        clearTimeout(timeoutId);
        if (disposed) return;
        setProviders({ ...parseProvidersConfig(response), retry });
      })
      .catch(() => {
        clearTimeout(timeoutId);
        if (disposed) return;
        setProviders({ ...UNAVAILABLE_PROVIDERS, error: true, retry });
      });

    return () => {
      disposed = true;
      clearTimeout(timeoutId);
      abortController.abort();
    };
  }, [requestVersion]);

  return providers;
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
  const googleColors = googleButtonPalette(theme.colorScheme);

  if (providers.loading) {
    return (
      <View style={styles.loadingButtons} accessibilityLabel={t('nativeStart.orContinueWith')}>
        <View style={[styles.loadingButton, { backgroundColor: theme.systemColors.fill }]} />
        <View style={[styles.loadingButton, { backgroundColor: theme.systemColors.fill }]} />
      </View>
    );
  }

  if (providers.error) {
    return (
      <View style={styles.discoveryError} accessibilityRole="alert">
        <Text style={[styles.discoveryErrorText, { color: theme.systemColors.secondaryLabel }]}>
          {t('nativeStart.providerDiscoveryError')}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('nativeStart.retryProviders')}
          disabled={disabled}
          onPress={providers.retry}
        >
          <Text style={[styles.retryLabel, { color: theme.systemColors.accent }]}>
            {t('nativeStart.retryProviders')}
          </Text>
        </Pressable>
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
            { backgroundColor: googleColors.background, borderColor: googleColors.border },
            disabled ? styles.disabled : undefined,
            pressed ? styles.pressed : undefined,
          ]}
        >
          <GoogleLogo />
          <Text style={[styles.googleLabel, { color: googleColors.label }]}>{t('login.providers.google')}</Text>
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
  googleLabel: {
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
  discoveryError: { alignItems: 'center', gap: 8 },
  discoveryErrorText: { fontSize: 14, textAlign: 'center' },
  retryLabel: { fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
});
