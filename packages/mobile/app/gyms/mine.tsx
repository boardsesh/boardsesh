import { useCallback, useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { Gym } from '@boardsesh/shared-schema';
import { useMyGyms, useProfile } from '../../src/lib/graphql/hooks';
import { useTheme } from '../../src/providers/theme-provider';
import { useToast } from '../../src/providers/toast-provider';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';
import { useSetting } from '../../src/settings';
import { hapticSelection } from '../../src/lib/haptics';
import { openValidatedUrl } from '../../src/lib/open-external-link';
import { WEB_BASE_URL } from '../../src/lib/env';
import { buildGymManageUrl } from '../../src/lib/gym-manage-url';
import { Text } from '../../src/components/Text';
import { Icon } from '../../src/components/Icon';
import { Button } from '../../src/components/Button';
import { PressableSurface } from '../../src/components/PressableSurface';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { MyGymRow } from '../../src/components/gym-directory/MyGymRow';
import { iosSystemColors } from '../../src/theme/ios-colors';
import { spacing, borderRadius } from '../../src/theme/tokens';

/**
 * "My gyms" — the owner's home for the gyms they run, reached from the More tab.
 * Lists the gyms from the `myGyms` query; each row taps through to the existing
 * gym editor and offers a hand-off to the web kiosk/TV manage console. Empty state
 * routes to the wall finder, where claiming a gym lives.
 *
 * A plain pushed route (not a modal): it's a destination with its own header, and
 * a modal over the iOS 26 native tab bar is the wrong surface here.
 */
export default function MyGymsScreen() {
  const router = useRouter();
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const screenOptions = useStackScreenOptions();
  const [kioskHintSeen, setKioskHintSeen] = useSetting('kioskHintSeen');

  const { data: profile } = useProfile();
  const currentUserId = profile?.id;
  const { data: connection, isLoading, isError, refetch } = useMyGyms({ enabled: !!currentUserId });

  const gyms = connection?.gyms ?? [];

  // Memoized (stable identity) so it doesn't defeat MyGymRow's memo on every
  // parent render; `t` only changes on a locale switch.
  const roleLabels = useMemo(
    () => ({
      owner: t('mobile.myGyms.roleOwner'),
      admin: t('mobile.gymGrant.roles.admin'),
      editor: t('mobile.gymGrant.roles.editor'),
      member: t('mobile.gymGrant.roles.member'),
    }),
    [t],
  );

  const header = (
    <Stack.Screen options={{ ...screenOptions, title: t('mobile.myGyms.screenTitle'), headerShown: true }} />
  );

  const openGym = useCallback(
    (gym: Gym) => {
      hapticSelection();
      router.push({ pathname: '/gyms/edit', params: { gymUuid: gym.uuid } });
    },
    [router],
  );

  const manageKiosks = useCallback(
    async (gym: Gym) => {
      // Prefer the slug, fall back to the uuid: the web manage route resolves
      // either, so a slugless legacy gym still opens its kiosk setup. Only a gym
      // with neither (a data-corruption edge — uuid is normally always present)
      // is genuinely unmanageable.
      const slugOrUuid = gym.slug ?? gym.uuid;
      if (!slugOrUuid) {
        showToast(t('mobile.myGyms.manageUnavailable'), 'error');
        return;
      }
      // First hand-off teaches that kiosk setup is a big-screen job; dismiss the
      // hint the moment they act on it.
      if (!kioskHintSeen) setKioskHintSeen(true);
      hapticSelection();
      // openURL (never canOpenURL — false for https on Android 11+ package
      // visibility); a genuine failure rejects and we toast.
      const opened = await openValidatedUrl(buildGymManageUrl(slugOrUuid), (url) => url.startsWith(WEB_BASE_URL));
      if (!opened) showToast(t('mobile.myGyms.manageError'), 'error');
    },
    [kioskHintSeen, setKioskHintSeen, showToast, t],
  );

  // Stable, void-returning wrapper so the async hand-off doesn't float a promise
  // through the row prop and doesn't defeat MyGymRow's memo with a fresh closure.
  const handleManageKiosks = useCallback(
    (gym: Gym) => {
      void manageKiosks(gym);
    },
    [manageKiosks],
  );

  const goToWallFinder = useCallback(() => {
    hapticSelection();
    router.push('/gyms');
  }, [router]);

  if (isLoading) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        {header}
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        {header}
        <Icon name="error" size={40} color={iosSystemColors.systemGray} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.myGyms.loadError')}
        </Text>
        <Button
          title={t('mobile.myGyms.retry')}
          variant="outlined"
          onPress={() => void refetch()}
          style={styles.stateButton}
        />
      </View>
    );
  }

  if (gyms.length === 0) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        {header}
        <Icon name="location" size={40} color={iosSystemColors.systemGray} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.myGyms.emptyTitle')}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.stateBody}>
          {t('mobile.myGyms.emptyBody')}
        </Text>
        <Button title={t('mobile.myGyms.findGym')} onPress={goToWallFinder} style={styles.stateButton} />
      </View>
    );
  }

  const showKioskHint = !kioskHintSeen && gyms.some((gym) => gym.canEdit);

  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      {header}
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.listContent}>
        {showKioskHint ? (
          <View style={[styles.hint, { backgroundColor: systemColors.secondaryBackground }]}>
            <Icon name="tv" size={18} color={systemColors.secondaryLabel} />
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.hintText}>
              {t('mobile.myGyms.kioskHint')}
            </Text>
            <PressableSurface
              onPress={() => setKioskHintSeen(true)}
              feedback="opacity"
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('mobile.myGyms.kioskHintDismiss')}
            >
              <Icon name="close" size={16} color={systemColors.secondaryLabel} />
            </PressableSurface>
          </View>
        ) : null}

        {gyms.map((gym) => (
          <MyGymRow
            key={gym.uuid}
            gym={gym}
            currentUserId={currentUserId}
            roleLabels={roleLabels}
            manageLabel={t('mobile.myGyms.manageKiosks')}
            manageAccessibilityLabel={t('mobile.myGyms.manageKiosksFor', { gym: gym.name })}
            noAddressLabel={t('mobile.myGyms.noAddress')}
            onOpenGym={openGym}
            onManageKiosks={handleManageKiosks}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[8],
  },
  stateTitle: {
    marginTop: spacing[3],
    textAlign: 'center',
  },
  stateBody: {
    marginTop: spacing[2],
    textAlign: 'center',
  },
  stateButton: {
    marginTop: spacing[4],
  },
  listContent: {
    padding: spacing[4],
    gap: spacing[3],
  },
  hint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderRadius: borderRadius.lg,
  },
  hintText: {
    flex: 1,
  },
});
