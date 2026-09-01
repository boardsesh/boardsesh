import React, { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { useIsAdmin } from '../../lib/graphql/hooks';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

// Admin-only screen — hardcoded English literals, the tester-screen convention.

/**
 * Route guard for the outline editor.
 *
 * Hiding the More-tab row is not a guard: a deep link reaches either editor
 * route directly, and the mutations behind them rewrite what every climber's
 * board renders. `__DEV__` always passes (the profile query often doesn't
 * resolve against a local backend); otherwise the flag has to come back true.
 * `useIsAdmin` fails closed, so a backend that doesn't yet serve the field —
 * or a request that errors — lands here rather than in the editor.
 *
 * A no-access state rather than a redirect, so a deep link that misses says why
 * (the `app/boards/edit.tsx` precedent).
 */
export function OutlineEditorGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { systemColors } = useTheme();
  const { isAdmin, isLoading } = useIsAdmin({ enabled: !__DEV__ });

  if (__DEV__) return <>{children}</>;

  if (isLoading) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.groupedBackground }]}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!isAdmin) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.groupedBackground }]}>
        <Icon name="lock" size={40} color={iosSystemColors.systemGray} />
        <Text variant="headline" style={styles.title}>
          {/* i18n-ignore-next-line — admin-only screen */}
          The outline editor is admin-only.
        </Text>
        <Button
          // i18n-ignore-next-line — admin-only screen
          title="Back"
          variant="outlined"
          onPress={() => router.back()}
          style={styles.button}
        />
      </View>
    );
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[6],
  },
  title: {
    marginTop: spacing[3],
    textAlign: 'center',
  },
  button: {
    marginTop: spacing[4],
  },
});
