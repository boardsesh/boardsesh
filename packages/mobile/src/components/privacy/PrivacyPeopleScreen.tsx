import { memo, useCallback, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Button } from '../Button';
import { ListRow } from '../ListRow';
import { ActivityIndicator } from '../ActivityIndicator';
import { OfflineState } from '../OfflineState';
import { readableColumnStyle } from '../ReadableColumn';
import { useTheme } from '../../providers/theme-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../../lib/auth-store';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { useFollowers, useProfile } from '../../lib/graphql/hooks';
import {
  useIncomingFollowRequests,
  usePrivacyFollowAction,
  usePrivacySettings,
} from '../../lib/graphql/hooks/use-privacy';
import { borderRadius, spacing } from '../../theme/tokens';

/** Which list the page shows: people asking to follow you, or people who do. */
export type PrivacyPeopleMode = 'request' | 'follower';
type PersonAction = 'approve' | 'decline' | 'remove';

interface PrivacyPerson {
  userId: string;
  displayName: string | null;
  kind: PrivacyPeopleMode;
}

const personKey = (person: PrivacyPerson) => `${person.kind}:${person.userId}`;

/** The card behind every row: the colour a native grouped form draws its rows on. */
function CardEdge({ edge }: { edge: 'top' | 'bottom' }) {
  const { systemColors } = useTheme();
  return (
    <View style={styles.gutter}>
      <View
        style={[
          readableColumnStyle,
          edge === 'top' ? styles.cardTop : styles.cardBottom,
          { backgroundColor: systemColors.secondaryGroupedBackground },
        ]}
      />
    </View>
  );
}

function RowSeparator() {
  const { systemColors } = useTheme();
  return (
    <View style={styles.gutter}>
      <View style={[readableColumnStyle, { backgroundColor: systemColors.secondaryGroupedBackground }]}>
        <View style={[styles.separator, { backgroundColor: systemColors.separator }]} />
      </View>
    </View>
  );
}

const PrivacyPersonRow = memo(function PrivacyPersonRow({
  person,
  disabled,
  busy,
  onAction,
}: {
  person: PrivacyPerson;
  disabled: boolean;
  /** This row's own action is the one in flight. */
  busy: boolean;
  onAction: (action: PersonAction, person: PrivacyPerson) => void;
}) {
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();
  const name = person.displayName ?? t('privacy.climber');
  return (
    <View style={styles.gutter}>
      <View style={[readableColumnStyle, { backgroundColor: systemColors.secondaryGroupedBackground }]}>
        <ListRow
          title={name}
          showSeparator={false}
          trailing={
            person.kind === 'request' ? (
              <View style={styles.actions}>
                <Button
                  title={t('privacy.decline')}
                  accessibilityLabel={t('privacy.declineNamed', { name })}
                  variant="text"
                  size="small"
                  disabled={disabled}
                  onPress={() => onAction('decline', person)}
                />
                <Button
                  title={t('privacy.approve')}
                  accessibilityLabel={t('privacy.approveNamed', { name })}
                  variant="tonal"
                  size="small"
                  disabled={disabled}
                  loading={busy}
                  onPress={() => onAction('approve', person)}
                />
              </View>
            ) : (
              <Button
                title={t('privacy.remove')}
                accessibilityLabel={t('privacy.removeNamed', { name })}
                variant="text"
                size="small"
                role="destructive"
                disabled={disabled}
                loading={busy}
                onPress={() => onAction('remove', person)}
              />
            )
          }
        />
      </View>
    </View>
  );
});

/**
 * Follow requests or followers, one list per page (`?mode=request|follower`),
 * opened from the Privacy page.
 *
 * Answering a request is one tap. Removing a follower asks first: it takes away
 * what they could see, and only they can undo it by asking again.
 */
export function PrivacyPeopleScreen() {
  const params = useLocalSearchParams<{ mode?: string }>();
  const mode: PrivacyPeopleMode = params.mode === 'follower' ? 'follower' : 'request';
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();
  const { scrollBottomPadding } = useBottomChromeMetrics();
  const { effectiveOffline } = useConnectivity();
  const confirm = useConfirm();
  const { data: profile } = useProfile();
  const settings = usePrivacySettings();
  const enabled = settings.data?.enabled === true;
  const requests = useIncomingFollowRequests(enabled && mode === 'request');
  const followers = useFollowers(profile?.id, enabled && mode === 'follower');
  const {
    mutate: runFollowAction,
    isPending: actionPending,
    isError: actionFailed,
    variables,
  } = usePrivacyFollowAction();
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = followers;
  const activeQuery = mode === 'request' ? requests : followers;
  // The settings read decides whether there is a list at all, so it blocks first.
  const blockingQuery = settings.data ? activeQuery : settings;
  const offlineState = useOfflineQueryState(blockingQuery);

  const people = useMemo<PrivacyPerson[]>(() => {
    if (mode === 'request') {
      return (requests.data ?? []).map((request) => ({
        userId: request.requesterId,
        displayName: request.displayName,
        kind: 'request',
      }));
    }
    // Offset pages: someone following between two page loads can repeat a row.
    const listed = new Map<string, PrivacyPerson>();
    for (const follower of followers.data?.pages.flatMap((page) => page.users) ?? []) {
      if (!listed.has(follower.id)) {
        listed.set(follower.id, { userId: follower.id, displayName: follower.displayName ?? null, kind: 'follower' });
      }
    }
    return [...listed.values()];
  }, [mode, requests.data, followers.data]);

  // Read after the remove confirm: a sign-out or account switch behind the
  // dialog must not let the old answer remove someone from the new account.
  const viewerRef = useRef(profile?.id);
  viewerRef.current = profile?.id;

  const handleAction = useCallback(
    async (action: PersonAction, person: PrivacyPerson) => {
      if (action === 'remove') {
        const name = person.displayName ?? t('privacy.climber');
        const askingViewerId = viewerRef.current;
        const credentialGeneration = captureAuthCredentialGeneration();
        const accepted = await confirm({
          title: t('privacy.removeFollowerTitle', { name }),
          message: t('privacy.removeFollowerMessage'),
          confirmLabel: t('privacy.removeFollower'),
          cancelLabel: t('privacy.cancel'),
          destructive: true,
        });
        if (!accepted) return;
        if (viewerRef.current !== askingViewerId || !isAuthCredentialGenerationCurrent(credentialGeneration)) return;
      }
      runFollowAction({ action, userId: person.userId });
    },
    [confirm, runFollowAction, t],
  );
  const onAction = useCallback(
    (action: PersonAction, person: PrivacyPerson) => void handleAction(action, person),
    [handleAction],
  );

  const disabled = effectiveOffline || actionPending;
  const busyUserId = actionPending ? variables?.userId : undefined;
  const renderPerson = useCallback(
    ({ item }: { item: PrivacyPerson }) => (
      <PrivacyPersonRow person={item} disabled={disabled} busy={item.userId === busyUserId} onAction={onAction} />
    ),
    [disabled, busyUserId, onAction],
  );

  // One page per end-reach; never drains the list.
  const loadNextPage = useCallback(() => {
    if (mode === 'follower' && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [mode, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const title = mode === 'request' ? t('privacy.requests') : t('privacy.followers');
  const screenOptions = <Stack.Screen options={{ title }} />;
  const pageStyle = [styles.page, { backgroundColor: systemColors.groupedBackground }];

  if (settings.data && !enabled) {
    return (
      <View style={pageStyle}>
        {screenOptions}
        <Text variant="body" color={systemColors.secondaryLabel} style={styles.message}>
          {t('privacy.accountControlsLater')}
        </Text>
      </View>
    );
  }
  if (offlineState.isBlocked && offlineState.reason) {
    return (
      <View style={pageStyle}>
        {screenOptions}
        <OfflineState reason={offlineState.reason} onRetry={() => void blockingQuery.refetch()} />
      </View>
    );
  }
  if (!settings.data || activeQuery.isPending) {
    return (
      <View style={[pageStyle, styles.centered]}>
        {screenOptions}
        <ActivityIndicator />
      </View>
    );
  }
  if (people.length === 0) {
    return (
      <View style={pageStyle}>
        {screenOptions}
        <Text variant="body" color={systemColors.secondaryLabel} style={styles.message}>
          {mode === 'request' ? t('privacy.noRequests') : t('privacy.noFollowers')}
        </Text>
      </View>
    );
  }

  return (
    <View style={pageStyle}>
      {screenOptions}
      <FlashList
        data={people}
        renderItem={renderPerson}
        keyExtractor={personKey}
        ItemSeparatorComponent={RowSeparator}
        ListHeaderComponent={
          <>
            {effectiveOffline || actionFailed ? (
              <Text
                variant="footnote"
                color={actionFailed ? systemColors.error : systemColors.secondaryLabel}
                accessibilityRole={actionFailed ? 'alert' : undefined}
                style={styles.notice}
              >
                {actionFailed ? t('privacy.followFailed') : t('privacy.offline')}
              </Text>
            ) : null}
            <CardEdge edge="top" />
          </>
        }
        ListFooterComponent={
          <>
            <CardEdge edge="bottom" />
            {isFetchingNextPage ? <ActivityIndicator style={styles.footerSpinner} /> : null}
          </>
        }
        onEndReached={loadNextPage}
        onEndReachedThreshold={0.5}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingTop: spacing[4], paddingBottom: scrollBottomPadding + spacing[4] }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  gutter: { paddingHorizontal: spacing[4] },
  cardTop: {
    height: borderRadius.lg,
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
    borderCurve: 'continuous',
  },
  cardBottom: {
    height: borderRadius.lg,
    borderBottomLeftRadius: borderRadius.lg,
    borderBottomRightRadius: borderRadius.lg,
    borderCurve: 'continuous',
  },
  separator: { height: StyleSheet.hairlineWidth, marginStart: spacing[4] },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  message: { ...readableColumnStyle, paddingHorizontal: spacing[4], paddingTop: spacing[6], textAlign: 'center' },
  notice: { ...readableColumnStyle, paddingHorizontal: spacing[4], paddingBottom: spacing[2] },
  footerSpinner: { marginTop: spacing[4] },
});
