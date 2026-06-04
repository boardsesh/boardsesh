import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import type BottomSheet from '@gorhom/bottom-sheet';
import type { SessionDetailTick, SessionFeedParticipant, SocialEntityType } from '@boardsesh/shared-schema';
import { formatTickAbsoluteTime } from '@boardsesh/profile-stats';
import { Text } from '../../src/components/Text';
import { Icon } from '../../src/components/Icon';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { SectionHeader } from '../../src/components/SectionHeader';
import { FeedSocialRow } from '../../src/components/you/FeedSocialRow';
import { CommentSheet } from '../../src/components/you/CommentSheet';
import { SessionDetailHero } from '../../src/components/session/SessionDetailHero';
import { SessionStatTiles } from '../../src/components/session/SessionStatTiles';
import { SessionAnalyticsSection } from '../../src/components/session/SessionAnalyticsSection';
import { SessionParticipantBreakdown } from '../../src/components/session/SessionParticipantBreakdown';
import { SessionTickRow } from '../../src/components/session/SessionTickRow';
import { SessionEditSheet } from '../../src/components/session/SessionEditSheet';
import { useSessionDetail, useProfile } from '../../src/lib/graphql/hooks';
import { navigateToSessionClimb } from '../../src/lib/session-tick-mapping';
import { TOOLBAR_RESERVE } from '../../src/theme/layout';
import { spacing } from '../../src/theme/tokens';
import { useTheme } from '../../src/providers/theme-provider';

export default function SessionDetailScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const navigation = useNavigation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const paddingBottom = TOOLBAR_RESERVE + insets.bottom + spacing[6];

  const { data: session, isPending } = useSessionDetail(sessionId);
  const { data: profile } = useProfile();

  const editSheetRef = useRef<BottomSheet | null>(null);
  const commentSheetRef = useRef<BottomSheet | null>(null);
  const [commentTarget, setCommentTarget] = useState<{ entityId: string; entityType: SocialEntityType } | null>(null);

  // Session name, falling back to a generated "<date>" label when unnamed.
  const title = useMemo(() => {
    if (!session) return '';
    if (session.sessionName) return session.sessionName;
    return formatTickAbsoluteTime(session.lastTickAt, 'MMM D, YYYY');
  }, [session]);

  const isMultiUser = (session?.participants.length ?? 0) > 1;
  const participantById = useMemo(() => {
    const map = new Map<string, SessionFeedParticipant>();
    for (const participant of session?.participants ?? []) map.set(participant.userId, participant);
    return map;
  }, [session]);

  const isOwnedInferred =
    !!session && session.sessionType === 'inferred' && !!profile?.id && session.ownerUserId === profile.id;

  const openComments = useCallback((entityId: string, entityType: SocialEntityType) => {
    setCommentTarget({ entityId, entityType });
    commentSheetRef.current?.snapToIndex(0);
  }, []);

  const handleOpenSessionComments = useCallback((id: string) => openComments(id, 'session'), [openComments]);
  const handleOpenTickComments = useCallback((tickUuid: string) => openComments(tickUuid, 'tick'), [openComments]);

  const handleTickPress = useCallback(
    (tick: SessionDetailTick) => navigateToSessionClimb(router, tick),
    [router],
  );

  // Header: title + edit overflow for an owned inferred session.
  useEffect(() => {
    navigation.setOptions({
      headerShown: true,
      title: title || t('mobileDetail.title'),
      headerRight: () =>
        isOwnedInferred ? (
          <Pressable
            onPress={() => editSheetRef.current?.snapToIndex(0)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('mobileDetail.editTitle')}
          >
            <Icon name="more.actions" size={22} color={systemColors.label} />
          </Pressable>
        ) : null,
    });
  }, [navigation, title, isOwnedInferred, systemColors, t]);

  if (isPending) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.centered}>
        <Icon name="history" size={48} color={systemColors.tertiaryLabel} />
        <Text variant="headline" color={systemColors.secondaryLabel} style={styles.notFound}>
          {t('mobileDetail.notFound')}
        </Text>
      </View>
    );
  }

  const header = (
    <View>
      <SessionDetailHero session={session} title={title} />
      <SessionStatTiles
        sends={session.totalSends}
        flashes={session.totalFlashes}
        attempts={session.totalAttempts}
        hardestGrade={session.hardestGrade}
      />

      <SessionAnalyticsSection ticks={session.ticks} />

      <SessionParticipantBreakdown participants={session.participants} />

      <View style={styles.social}>
        <FeedSocialRow
          entityId={session.sessionId}
          upvotes={session.upvotes}
          userVote={null}
          commentCount={session.commentCount}
          onOpenComments={handleOpenSessionComments}
        />
      </View>

      <SectionHeader title={t('detail.climbsCount', { count: session.ticks.length })} />
    </View>
  );

  return (
    <View style={styles.flex}>
      <FlashList
        data={session.ticks}
        renderItem={({ item }) => (
          <SessionTickRow
            tick={item}
            isMultiUser={isMultiUser}
            participant={participantById.get(item.userId)}
            onPress={handleTickPress}
            onOpenComments={handleOpenTickComments}
          />
        )}
        keyExtractor={(tick) => tick.uuid}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingBottom }}
      />

      <SessionEditSheet sheetRef={editSheetRef} session={session} onClose={() => undefined} />
      <CommentSheet
        sheetRef={commentSheetRef}
        entityId={commentTarget?.entityId ?? null}
        entityType={commentTarget?.entityType ?? 'session'}
        onClose={() => setCommentTarget(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[3], paddingHorizontal: spacing[8] },
  notFound: { textAlign: 'center' },
  social: { paddingHorizontal: spacing[4], marginTop: spacing[2] },
});
