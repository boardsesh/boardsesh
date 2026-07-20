// The whole body of every canonical board entry route (`app/[board_name]/…`,
// `app/b/[board_slug]/…`, and the legacy `climbs/[climbUuid]` redirector).
//
// Those routes are redirectors: they adopt the URL's board and hand off to the
// Climbs tab / play drawer, so the only thing they ever draw is a spinner or a
// not-found. Keeping that here means the seven route files stay at "read params,
// build a target" and can't drift from each other.

import { StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator } from './ActivityIndicator';
import { Icon } from './Icon';
import { Text } from './Text';
import { useTheme } from '../providers/theme-provider';
import type { BoardRouteTarget } from '../lib/routing/board-route-target';
import { useBoardRouteTarget, type BoardRouteMode, type BoardRouteStatus } from '../lib/routing/use-board-route-target';

export function BoardRouteRedirect({ status }: { status: BoardRouteStatus }) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();

  return (
    <View style={styles.container}>
      {/* Headerless: a redirector that shows a back chevron for the split second
          before it navigates away just looks like a broken screen. */}
      <Stack.Screen options={{ headerShown: false }} />
      {status === 'resolving' ? (
        <ActivityIndicator size="large" />
      ) : (
        <>
          <Icon name="error" size={48} color={systemColors.secondaryLabel} />
          <Text variant="headline" style={styles.errorText}>
            {t('mobile.detail.notFound')}
          </Text>
        </>
      )}
    </View>
  );
}

/**
 * Drive `target` to its destination and render the redirector while it happens.
 * `target` is `null` when the URL didn't parse, which renders the not-found.
 */
export function BoardRouteHandoff({ target, mode }: { target: BoardRouteTarget | null; mode?: BoardRouteMode }) {
  const status = useBoardRouteTarget(target, { mode });
  return <BoardRouteRedirect status={status} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  errorText: {
    opacity: 0.6,
  },
});
