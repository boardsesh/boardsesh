import { useEffect, useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

/**
 * "We found sends of yours that never reached the server" (issue #5335).
 *
 * The count arrives as a route param rather than being re-read here, because
 * `SendRecoveryGate` clears the note in the database before it pushes this
 * screen — the number is already spent by the time this mounts.
 *
 * The copy deliberately promises delivery rather than claiming it: the sends are
 * back on the queue and will land, but at this moment some of them may still be
 * in flight, and a climber told "3 sends recovered" who then sees one still
 * pending has been lied to. "On their way" is true when it is shown and stays
 * true afterwards.
 */
export function SendRecoveryScreen() {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const params = useLocalSearchParams<{ count?: string }>();

  const recoveredCount = useMemo(() => {
    const parsed = Number(params.count);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }, [params.count]);

  // Nothing to announce means nothing to show. Reachable only if the route is
  // opened without its param (a stale deep link, a dev reload), and closing is
  // honester than rendering a sentence about zero sends.
  useEffect(() => {
    if (recoveredCount === null) router.back();
  }, [recoveredCount]);

  if (recoveredCount === null) return null;

  return (
    <View style={[styles.root, { backgroundColor: systemColors.groupedBackground, paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text variant="title3" style={styles.title}>
          {t('mobile.sendRecovery.title', { count: recoveredCount })}
        </Text>
        <Text variant="body" color={systemColors.secondaryLabel}>
          {t('mobile.sendRecovery.body', { count: recoveredCount })}
        </Text>
        <View style={styles.actions}>
          <Button
            title={t('mobile.sendRecovery.dismiss')}
            onPress={() => router.back()}
            variant="filled"
            size="large"
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[4],
    gap: spacing[3],
  },
  title: {
    fontWeight: '700',
  },
  actions: {
    gap: spacing[2],
    marginTop: spacing[2],
  },
});
