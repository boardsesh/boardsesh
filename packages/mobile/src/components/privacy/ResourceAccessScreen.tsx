import { memo, useCallback, useMemo, useState } from 'react';
import { View, TextInput } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { useProfile, useSearchUsers } from '../../lib/graphql/hooks';
import { usePrivacySettings } from '../../lib/graphql/hooks/use-privacy';
import {
  useResourceAccessAction,
  useResourceAccessRequests,
  useResourcePrivacy,
} from '../../lib/graphql/hooks/use-resource-privacy';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';

type AccessPerson = {
  userId: string;
  displayName?: string | null;
  status: 'pending' | 'approved' | 'revoked' | 'invite';
};
const personKey = (person: AccessPerson) => person.userId;
const AccessPersonRow = memo(function AccessPersonRow({
  person,
  disabled,
  onAction,
}: {
  person: AccessPerson;
  disabled: boolean;
  onAction: (action: 'invite' | 'approve' | 'revoke', userId: string) => void;
}) {
  const { t } = useTranslation('settings');
  const { spacing } = useTheme();
  return (
    <View style={{ padding: spacing[4], gap: spacing[2] }}>
      <Text variant="headline">{person.displayName ?? t('privacy.climber')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] }}>
        {person.status === 'pending' ? (
          <Button title={t('privacy.approve')} disabled={disabled} onPress={() => onAction('approve', person.userId)} />
        ) : null}
        {person.status === 'pending' || person.status === 'approved' ? (
          <Button
            title={person.status === 'pending' ? t('privacy.decline') : t('privacy.removeAccess')}
            variant="outlined"
            disabled={disabled}
            onPress={() => onAction('revoke', person.userId)}
          />
        ) : (
          <Button title={t('privacy.invite')} disabled={disabled} onPress={() => onAction('invite', person.userId)} />
        )}
      </View>
    </View>
  );
});

export function ResourceAccessScreen() {
  const params = useLocalSearchParams<{ kind: string; resourceId: string }>();
  const kind = params.kind === 'session' ? 'session' : 'board';
  const resourceId = typeof params.resourceId === 'string' ? params.resourceId : '';
  const { t } = useTranslation('settings');
  const { spacing, systemColors, brandColors } = useTheme();
  const { effectiveOffline } = useConnectivity();
  const { data: profile } = useProfile();
  const { data: settings } = usePrivacySettings();
  const { data: privacy } = useResourcePrivacy(kind, resourceId);
  const canManage = settings?.enabled === true && !!profile?.id && privacy?.ownerId === profile.id;
  const [searchText, setSearchText] = useState('');
  const isSearching = searchText.trim().length >= 2;
  const grants = useResourceAccessRequests(kind, resourceId, canManage);
  const search = useSearchUsers(searchText, canManage && isSearching);
  const action = useResourceAccessAction();
  const people = useMemo<AccessPerson[]>(() => {
    if (!canManage) return [];
    const grantIndex = new Map((grants.data ?? []).map((grant) => [grant.userId, grant.status]));
    return isSearching
      ? (search.data?.pages.flatMap((page) => page.results) ?? [])
          .filter((result) => result.user.id !== profile?.id)
          .map((result) => ({
            userId: result.user.id,
            displayName: result.user.displayName,
            status: grantIndex.get(result.user.id) ?? 'invite',
          }))
      : (grants.data ?? []).filter((grant) => grant.status !== 'revoked');
  }, [canManage, grants.data, isSearching, search.data, profile?.id]);
  const onAction = useCallback(
    (next: 'invite' | 'approve' | 'revoke', userId: string) => {
      action.mutate({ action: next, kind, resourceId, userId });
    },
    [action, kind, resourceId],
  );
  const disabled = action.isPending || effectiveOffline;
  const renderPerson = useCallback(
    ({ item }: { item: AccessPerson }) => <AccessPersonRow person={item} disabled={disabled} onAction={onAction} />,
    [disabled, onAction],
  );
  const loadNext = useCallback(() => {
    if (isSearching && search.hasNextPage && !search.isFetchingNextPage) void search.fetchNextPage();
  }, [isSearching, search]);
  return (
    <View style={{ flex: 1, backgroundColor: systemColors.background }}>
      <FlashList
        data={people}
        renderItem={renderPerson}
        keyExtractor={personKey}
        onEndReached={loadNext}
        onEndReachedThreshold={0.5}
        contentInsetAdjustmentBehavior="automatic"
        ListHeaderComponent={
          <View style={{ padding: spacing[4], gap: spacing[3] }}>
            <Text variant="title2">{t('privacy.manageAccess')}</Text>
            {canManage ? (
              <TextInput
                value={searchText}
                onChangeText={setSearchText}
                placeholder={t('privacy.searchClimbers')}
                accessibilityLabel={t('privacy.searchClimbers')}
                placeholderTextColor={systemColors.secondaryLabel}
                style={{
                  color: systemColors.label,
                  backgroundColor: systemColors.secondaryBackground,
                  padding: spacing[3],
                  minHeight: 44,
                }}
              />
            ) : null}
            {effectiveOffline ? <Text>{t('privacy.offline')}</Text> : null}
            {action.isError || grants.isError || search.isError ? (
              <Text color={brandColors.error} accessibilityRole="alert">
                {t('privacy.saveFailed')}
              </Text>
            ) : null}
            {action.isSuccess ? <Text>{t('privacy.saved')}</Text> : null}
          </View>
        }
      />
    </View>
  );
}
