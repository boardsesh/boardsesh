// The whole body of every canonical board entry route (`app/[board_name]/…`,
// `app/b/[board_slug]/…`, and the legacy `climbs/[climbUuid]` redirector).
//
// Those routes are redirectors: they adopt the URL's board and hand off to the
// Climbs tab / play drawer, so the only thing they ever draw is a spinner or a
// not-found. Keeping that here means the seven route files stay at "read params,
// build a target" and can't drift from each other.

import { StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator } from './ActivityIndicator';
import { Button } from './Button';
import { Icon } from './Icon';
import { Text } from './Text';
import { useTheme } from '../providers/theme-provider';
import type { BoardRouteTarget } from '../lib/routing/board-route-target';
import { useBoardRouteTarget, type BoardRouteMode, type BoardRouteStatus } from '../lib/routing/use-board-route-target';

/** Where `app/+not-found.tsx` sends people; the dead end below has to match it. */
const HOME_TAB = '/(tabs)/home' as const;

export function BoardRouteRedirect({ status }: { status: BoardRouteStatus }) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const router = useRouter();

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
          {/* The one way out. These routes mount headerless at the ROOT stack, so
              a cold open from a dead link has no header, no tab bar and nothing
              beneath it — on Android the only remaining gesture is back, which
              exits the app. `replace`, not `push`: the broken URL must not stay
              on the stack for back to return to. */}
          <Button title={t('mobile.detail.backToHome')} onPress={() => router.replace(HOME_TAB)} variant="tonal" />
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
