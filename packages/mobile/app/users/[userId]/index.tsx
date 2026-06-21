import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { Button } from '../../../src/components/Button';
import { SegmentedControl } from '../../../src/components/SegmentedControl';
import { PublicProfileHeaderBlock } from '../../../src/components/you/PublicProfileHeaderBlock';
import { ProgressTab } from '../../../src/components/you/ProgressTab';
import { SessionsTab } from '../../../src/components/you/SessionsTab';
import { LogbookTab } from '../../../src/components/you/LogbookTab';
import { ProfileClimbsTab } from '../../../src/components/you/ProfileClimbsTab';
import { useProfile, usePublicProfile, useYouProfileData } from '../../../src/lib/graphql/hooks';
import { useTheme } from '../../../src/providers/theme-provider';
import { spacing } from '../../../src/theme/tokens';

type ProfileSection = 'progress' | 'sessions' | 'logbook' | 'climbs';

export default function PublicProfileScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const { t } = useTranslation('you');
  const { systemColors, brandColors } = useTheme();
  const navigation = useNavigation();

  const { data: currentProfile } = useProfile();
  const currentUserId = currentProfile?.id;
  const isSelf = !!currentUserId && currentUserId === userId;

  const publicProfile = usePublicProfile(userId);
  const youData = useYouProfileData(userId);

  const [activeSection, setActiveSection] = useState<ProfileSection>('progress');

  const profile = publicProfile.data;
  const displayName = profile?.displayName || t('mobile.unknownName');

  // Drive the native stack header (back chevron + title). Set once the name
  // resolves so a long display name folds into the compact bar on iOS.
  useEffect(() => {
    navigation.setOptions({
      headerShown: true,
      // Opaque (not the app's translucent push header) so the in-body avatar/name
      // block lays out below the bar instead of scrolling under it.
      headerTransparent: false,
      headerBlurEffect: undefined,
      title: profile ? displayName : t('mobile.profile.title'),
    });
  }, [navigation, profile, displayName, t]);

  // instagramUrl rides the publicProfile query once PR #2902 (backend) merges to
  // main; until then it resolves to null and the chip stays hidden. The cast is a
  // forward-compat shim — drop it for `profile.instagramUrl` after syncing main.
  const instagramUrl = useMemo(
    () => (profile as unknown as { instagramUrl?: string | null } | undefined)?.instagramUrl ?? null,
    [profile],
  );

  const sectionOptions = useMemo(
    () => [
      { key: 'progress' as const, label: t('tabs.progress') },
      { key: 'sessions' as const, label: t('tabs.sessions') },
      { key: 'logbook' as const, label: t('tabs.logbook') },
      { key: 'climbs' as const, label: t('tabs.climbs') },
    ],
    [t],
  );

  const handleRetry = useCallback(() => {
    void publicProfile.refetch();
  }, [publicProfile]);

  if (publicProfile.isPending) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.groupedBackground }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (publicProfile.isError) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.groupedBackground }]}>
        <Icon name="error" size={48} color={systemColors.tertiaryLabel} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.profile.errorTitle')}
        </Text>
        <View style={styles.stateCta}>
          <Button title={t('mobile.social.retry')} onPress={handleRetry} />
        </View>
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.groupedBackground }]}>
        <Icon name="people" size={48} color={systemColors.tertiaryLabel} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.profile.notFoundTitle')}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.stateBody}>
          {t('mobile.profile.notFoundBody')}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: systemColors.groupedBackground }]}>
      <PublicProfileHeaderBlock profile={profile} instagramUrl={instagramUrl} currentUserId={currentUserId} />

      <View style={styles.segmentWrap}>
        <SegmentedControl
          options={sectionOptions}
          selectedKey={activeSection}
          onSelect={setActiveSection}
          trackColor={systemColors.fill}
          accessibilityLabel={displayName}
        />
      </View>

      <View style={styles.flex}>
        {activeSection === 'progress' ? <ProgressTab data={youData} topInset={0} userId={userId} /> : null}
        {activeSection === 'sessions' ? <SessionsTab userId={userId} topInset={0} /> : null}
        {activeSection === 'logbook' ? <LogbookTab userId={userId} topInset={0} viewerIsOwner={isSelf} /> : null}
        {activeSection === 'climbs' ? <ProfileClimbsTab userId={userId} topInset={0} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[8],
  },
  segmentWrap: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  stateTitle: {
    marginTop: spacing[3],
    textAlign: 'center',
  },
  stateBody: {
    textAlign: 'center',
  },
  stateCta: {
    marginTop: spacing[4],
  },
});
