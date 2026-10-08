import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { PrivacyResourceAudience } from '@boardsesh/graphql/operations/privacy';
import { Text } from '../Text';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { useTheme } from '../../providers/theme-provider';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';
import { useFollowers, useProfile } from '../../lib/graphql/hooks';
import {
  PRIVACY_ONBOARDING_VERSION,
  useIncomingFollowRequests,
  usePrivacyFollowAction,
  usePrivacySettings,
  useUpdatePrivacySettings,
} from '../../lib/graphql/hooks/use-privacy';
import { AudiencePicker, SESSION_AUDIENCES } from './AudiencePicker';

interface PrivacyPerson {
  userId: string;
  displayName: string | null;
  kind: 'request' | 'follower';
}
const personKey = (person: PrivacyPerson) => `${person.kind}:${person.userId}`;
const PrivacyPersonRow = memo(function PrivacyPersonRow({
  person,
  onAction,
  disabled,
}: {
  person: PrivacyPerson;
  onAction: (action: 'approve' | 'decline' | 'remove', userId: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation('settings');
  const { spacing } = useTheme();
  return (
    <View style={{ padding: spacing[4], gap: spacing[2] }}>
      <Text variant="headline">{person.displayName ?? t('privacy.climber')}</Text>
      <View style={styles.actions}>
        {person.kind === 'request' ? (
          <>
            <Button
              title={t('privacy.approve')}
              disabled={disabled}
              onPress={() => onAction('approve', person.userId)}
            />
            <Button
              title={t('privacy.decline')}
              variant="outlined"
              disabled={disabled}
              onPress={() => onAction('decline', person.userId)}
            />
          </>
        ) : (
          <Button
            title={t('privacy.removeFollower')}
            variant="outlined"
            disabled={disabled}
            onPress={() => onAction('remove', person.userId)}
          />
        )}
      </View>
    </View>
  );
});

export function PrivacySettingsScreen({ onboarding = false }: { onboarding?: boolean }) {
  const { t } = useTranslation('settings');
  const { spacing, systemColors, brandColors } = useTheme();
  const { effectiveOffline } = useConnectivity();
  const { data: profile } = useProfile();
  const settings = usePrivacySettings();
  const update = useUpdatePrivacySettings();
  const enabled = settings.data?.enabled === true;
  const requests = useIncomingFollowRequests(enabled && !onboarding);
  const followers = useFollowers(profile?.id, enabled && !onboarding);
  const followAction = usePrivacyFollowAction();
  const [isPrivate, setIsPrivate] = useState<boolean | null>(null);
  const [sessionAudience, setSessionAudience] = useState<PrivacyResourceAudience>('public');
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [peopleMode, setPeopleMode] = useState<'request' | 'follower'>('request');
  useEffect(() => {
    if (!settings.data || dirty) return;
    if (!onboarding) setIsPrivate(settings.data.isPrivate);
    setSessionAudience(settings.data.defaultSessionAudience);
  }, [settings.data, dirty, onboarding]);
  const people = useMemo<PrivacyPerson[]>(() => {
    if (onboarding) return [];
    return peopleMode === 'request'
      ? (requests.data ?? []).map((request) => ({
          userId: request.requesterId,
          displayName: request.displayName,
          kind: 'request',
        }))
      : (followers.data?.pages.flatMap((page) => page.users) ?? []).map((person) => ({
          userId: person.id,
          displayName: person.displayName ?? null,
          kind: 'follower',
        }));
  }, [onboarding, peopleMode, requests.data, followers.data]);
  const handleAction = useCallback(
    (action: 'approve' | 'decline' | 'remove', userId: string) => {
      followAction.mutate({ action, userId });
    },
    [followAction],
  );
  const disabled = effectiveOffline || update.isPending || followAction.isPending;
  const renderPerson = useCallback(
    ({ item }: { item: PrivacyPerson }) => (
      <PrivacyPersonRow person={item} onAction={handleAction} disabled={disabled} />
    ),
    [handleAction, disabled],
  );
  const loadNextFollowers = useCallback(() => {
    if (peopleMode === 'follower' && followers.hasNextPage && !followers.isFetchingNextPage)
      void followers.fetchNextPage();
  }, [peopleMode, followers]);
  const chooseAccount = (next: boolean) => {
    setIsPrivate(next);
    setSessionAudience(next ? 'followers' : 'public');
    setDirty(true);
    setSaved(false);
  };
  const save = () => {
    if (isPrivate === null || disabled || !enabled) return;
    update.mutate(
      {
        isPrivate,
        defaultSessionAudience: sessionAudience,
        ...(onboarding ? { privacyOnboardingVersion: PRIVACY_ONBOARDING_VERSION } : {}),
      },
      {
        onSuccess: () => {
          setDirty(false);
          setSaved(true);
          if (onboarding) router.back();
        },
      },
    );
  };
  const header = (
    <View style={{ padding: spacing[4], gap: spacing[4] }}>
      <Text variant="title2">{onboarding ? t('privacy.onboardingTitle') : t('privacy.title')}</Text>
      <Text>{t('privacy.intro')}</Text>
      {!settings.data && settings.isPending ? (
        <ActivityIndicator />
      ) : !enabled ? (
        <Text>{t('privacy.unavailable')}</Text>
      ) : (
        <>
          <Text variant="headline">{t('privacy.accountAudience')}</Text>
          <View style={styles.actions}>
            <Button
              title={t('privacy.publicAccount')}
              variant={isPrivate === false ? 'filled' : 'outlined'}
              disabled={disabled}
              onPress={() => chooseAccount(false)}
            />
            <Button
              title={t('privacy.privateAccount')}
              variant={isPrivate === true ? 'filled' : 'outlined'}
              disabled={disabled}
              onPress={() => chooseAccount(true)}
            />
          </View>
          <Text variant="footnote">{t('privacy.privateExplanation')}</Text>
          <AudiencePicker
            resource
            audience={sessionAudience}
            confirmPublic={isPrivate === true}
            options={SESSION_AUDIENCES}
            disabled={disabled}
            label={t('privacy.sessionDefault')}
            onChange={(audience) => {
              setSessionAudience(audience);
              setDirty(true);
              setSaved(false);
            }}
          />
          <Text variant="footnote">{t('privacy.boardReview')}</Text>
          <Button title={t('privacy.reviewBoards')} variant="outlined" onPress={() => router.push('/boards/manage')} />
          {effectiveOffline ? <Text color={brandColors.error}>{t('privacy.offline')}</Text> : null}
          {update.isError || followAction.isError ? (
            <Text accessibilityRole="alert" color={brandColors.error}>
              {t('privacy.saveFailed')}
            </Text>
          ) : null}
          {saved ? (
            <Text accessibilityRole="alert" color={brandColors.success}>
              {t('privacy.saved')}
            </Text>
          ) : null}
          <Button
            title={onboarding ? t('privacy.finishSetup') : t('privacy.save')}
            loading={update.isPending}
            disabled={disabled || isPrivate === null || (!dirty && !onboarding)}
            onPress={save}
          />
          {!onboarding ? (
            <>
              <View style={styles.actions}>
                <Button
                  title={t('privacy.requests')}
                  variant={peopleMode === 'request' ? 'filled' : 'outlined'}
                  onPress={() => setPeopleMode('request')}
                />
                <Button
                  title={t('privacy.followers')}
                  variant={peopleMode === 'follower' ? 'filled' : 'outlined'}
                  onPress={() => setPeopleMode('follower')}
                />
              </View>
              {requests.isError || followers.isError ? <Text>{t('privacy.loadFailed')}</Text> : null}
              {(peopleMode === 'request' ? requests.isFetching : followers.isFetching) ? <ActivityIndicator /> : null}
            </>
          ) : null}
        </>
      )}
    </View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: systemColors.background }}>
      <FlashList
        data={enabled ? people : []}
        renderItem={renderPerson}
        keyExtractor={personKey}
        ListHeaderComponent={header}
        onEndReached={loadNextFollowers}
        onEndReachedThreshold={0.5}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: spacing[8] }}
      />
    </View>
  );
}
const styles = StyleSheet.create({ actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 } });
