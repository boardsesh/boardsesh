import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '../../src/components/Button';
import { Text } from '../../src/components/Text';
import { useAuth } from '../../src/providers/auth-provider';
import { useTheme } from '../../src/providers/theme-provider';
import { spacing } from '../../src/theme/tokens';

export default function SessionUnavailableScreen() {
  const { refreshAuthState } = useAuth();
  const { t } = useTranslation(['auth', 'common']);
  const theme = useTheme();
  const [retrying, setRetrying] = useState(false);

  async function retry(): Promise<void> {
    setRetrying(true);
    try {
      await refreshAuthState();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <View
      testID="auth-session-unavailable"
      style={[styles.container, { backgroundColor: theme.systemColors.background }]}
      accessibilityRole="alert"
    >
      <View style={styles.content}>
        <Text variant="body" color={theme.systemColors.secondaryLabel} style={styles.message}>
          {t('nativeStart.networkError')}
        </Text>
        <Button
          title={t('common:actions.retry')}
          onPress={() => {
            void retry();
          }}
          loading={retrying}
          disabled={retrying}
          size="large"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[6],
  },
  content: {
    width: '100%',
    maxWidth: 420,
    gap: spacing[6],
  },
  message: {
    textAlign: 'center',
  },
});
