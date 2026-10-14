import { memo, useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Button } from '../Button';
import { ListRow } from '../ListRow';
import { SearchField } from '../SearchField';
import { useTheme } from '../../providers/theme-provider';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useBoard, useProfile, useSearchUsers } from '../../lib/graphql/hooks';
import { usePrivacySettings } from '../../lib/graphql/hooks/use-privacy';
import {
  useResourceAccessAction,
  useResourceAccessRequests,
  useResourceGrantStatuses,
  useResourcePrivacy,
} from '../../lib/graphql/hooks/use-resource-privacy';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';
import { OwnPublicGymWarning } from '../board-discovery/OwnPublicGymWarning';

/** The readable column every grouped settings page keeps to on a wide screen. */
const READABLE_WIDTH = 672;

type AccessPerson = {
  userId: string;
  displayName?: string | null;
  status: 'pending' | 'approved' | 'revoked' | 'invite';
};
/**
 * Where a row sits in the grouped card, worked out once per list change so the
 * row (and `renderItem`) never needs the list's length to round its corners.
 */
type CardPosition = 'only' | 'first' | 'middle' | 'last';
type AccessPersonItem = { person: AccessPerson; position: CardPosition };

const personItemKey = (item: AccessPersonItem) => item.person.userId;

function cardPosition(index: number, count: number): CardPosition {
  if (count === 1) return 'only';
  if (index === 0) return 'first';
  return index === count - 1 ? 'last' : 'middle';
}

const AccessPersonRow = memo(function AccessPersonRow({
  person,
  position,
  disabled,
  onAction,
}: {
  person: AccessPerson;
  position: CardPosition;
  disabled: boolean;
  onAction: (action: 'invite' | 'approve' | 'revoke', userId: string) => void;
}) {
  const { t } = useTranslation('settings');
  const { spacing, borderRadius, systemColors } = useTheme();
  const roundTop = position === 'only' || position === 'first';
  const roundBottom = position === 'only' || position === 'last';
  return (
    <View
      style={{
        width: '100%',
        maxWidth: READABLE_WIDTH,
        alignSelf: 'center',
        paddingHorizontal: spacing[4],
      }}
    >
      <View
        style={{
          overflow: 'hidden',
          backgroundColor: systemColors.secondaryGroupedBackground,
          borderTopLeftRadius: roundTop ? borderRadius.lg : 0,
          borderTopRightRadius: roundTop ? borderRadius.lg : 0,
          borderBottomLeftRadius: roundBottom ? borderRadius.lg : 0,
          borderBottomRightRadius: roundBottom ? borderRadius.lg : 0,
        }}
      >
        <ListRow
          title={person.displayName ?? t('privacy.climber')}
          haptic={false}
          showSeparator={!roundBottom}
          // The actions get their own line under the name, and wrap: beside it,
          // German labels or a large text size squeezed the name away and
          // clipped Decline off the edge.
          trailingPlacement="below"
          trailing={
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] }}>
              {person.status === 'pending' ? (
                <Button
                  title={t('privacy.approve')}
                  size="small"
                  disabled={disabled}
                  onPress={() => onAction('approve', person.userId)}
                />
              ) : null}
              {person.status === 'pending' || person.status === 'approved' ? (
                <Button
                  title={person.status === 'pending' ? t('privacy.decline') : t('privacy.removeAccess')}
                  size="small"
                  variant="outlined"
                  disabled={disabled}
                  onPress={() => onAction('revoke', person.userId)}
                />
              ) : (
                <Button
                  title={t('privacy.invite')}
                  size="small"
                  disabled={disabled}
                  onPress={() => onAction('invite', person.userId)}
                />
              )}
            </View>
          }
        />
      </View>
    </View>
  );
});

export function ResourceAccessScreen() {
  const params = useLocalSearchParams<{ kind: string; resourceId: string }>();
  const kind = params.kind === 'session' ? 'session' : 'board';
  const resourceId = typeof params.resourceId === 'string' ? params.resourceId : '';
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  const { spacing, systemColors, brandColors } = useTheme();
  const { scrollBottomPadding } = useBottomChromeMetrics();
  const { effectiveOffline } = useConnectivity();
  const { data: profile } = useProfile();
  const { data: settings } = usePrivacySettings();
  const { data: privacy } = useResourcePrivacy(kind, resourceId);
  const canManage = settings?.enabled === true && !!profile?.id && privacy?.ownerId === profile.id;
  // A board in the owner's own public gym is shown at that gym's address to
  // everyone its own location is hidden from: OwnPublicGymWarning says so.
  const { data: board } = useBoard(kind === 'board' && canManage ? resourceId : null);
  const [searchText, setSearchText] = useState('');
  const isSearching = searchText.trim().length >= 2;
  const grants = useResourceAccessRequests(kind, resourceId, canManage);
  const search = useSearchUsers(searchText, canManage && isSearching);
  const searchUserIdPages = useMemo(
    () => (search.data?.pages ?? []).map((page) => page.results.map((result) => result.user.id)),
    [search.data],
  );
  // Each search result's grant comes from the server, not from the loaded
  // access list: a share link can put a member past its first page.
  const statuses = useResourceGrantStatuses(kind, resourceId, searchUserIdPages, canManage && isSearching);
  const action = useResourceAccessAction();
  const people = useMemo<AccessPerson[]>(() => {
    if (!canManage) return [];
    if (!isSearching) {
      // Pages are offsets, so a join between two page loads can repeat a row.
      const listed = new Map<string, AccessPerson>();
      for (const grant of grants.data?.pages.flat() ?? []) {
        if (grant.status !== 'revoked' && !listed.has(grant.userId)) listed.set(grant.userId, grant);
      }
      return [...listed.values()];
    }
    const grantIndex = new Map(statuses.grants.map((grant) => [grant.userId, grant.status]));
    return (search.data?.pages ?? [])
      .filter((_, pageIndex) => statuses.loadedPages[pageIndex])
      .flatMap((page) => page.results)
      .filter((result) => result.user.id !== profile?.id)
      .map((result) => ({
        userId: result.user.id,
        displayName: result.user.displayName,
        status: grantIndex.get(result.user.id) ?? 'invite',
      }));
  }, [canManage, grants.data, isSearching, search.data, statuses, profile?.id]);
  const personItems = useMemo<AccessPersonItem[]>(
    () => people.map((person, index, all) => ({ person, position: cardPosition(index, all.length) })),
    [people],
  );
  const onAction = useCallback(
    (next: 'invite' | 'approve' | 'revoke', userId: string) => {
      action.mutate({ action: next, kind, resourceId, userId });
    },
    [action, kind, resourceId],
  );
  const disabled = action.isPending || effectiveOffline;
  const renderPerson = useCallback(
    ({ item }: { item: AccessPersonItem }) => (
      <AccessPersonRow person={item.person} position={item.position} disabled={disabled} onAction={onAction} />
    ),
    [disabled, onAction],
  );
  const loadNext = useCallback(() => {
    const list = isSearching ? search : grants;
    if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
  }, [isSearching, search, grants]);
  const hasError = action.isError || grants.isError || search.isError || statuses.isError;
  return (
    <View style={{ flex: 1, backgroundColor: systemColors.groupedBackground }}>
      <FlashList
        data={personItems}
        renderItem={renderPerson}
        keyExtractor={personItemKey}
        onEndReached={loadNext}
        onEndReachedThreshold={0.5}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: scrollBottomPadding + spacing[4] }}
        ListHeaderComponent={
          <View
            style={{
              width: '100%',
              maxWidth: READABLE_WIDTH,
              alignSelf: 'center',
              padding: spacing[4],
              gap: spacing[3],
            }}
          >
            {canManage ? <OwnPublicGymWarning gymUuid={board?.gymUuid} /> : null}
            {canManage ? (
              <SearchField
                value={searchText}
                onChangeText={setSearchText}
                placeholder={t('privacy.searchClimbers')}
                clearAccessibilityLabel={tCommon('mobile.a11y.clearSearch')}
              />
            ) : null}
            {effectiveOffline ? (
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {t('privacy.offline')}
              </Text>
            ) : null}
            {hasError ? (
              <Text variant="footnote" color={brandColors.error} accessibilityRole="alert">
                {t('privacy.saveFailed')}
              </Text>
            ) : null}
            {action.isSuccess ? (
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {t('privacy.saved')}
              </Text>
            ) : null}
          </View>
        }
      />
    </View>
  );
}
