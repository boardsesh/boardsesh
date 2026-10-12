import { scopedRouter as router } from '../../lib/routing/scoped-navigation';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { PrivacyLocationAudience } from '@boardsesh/graphql/operations/privacy';
import { AudiencePicker, BOARD_AUDIENCES, SESSION_AUDIENCES } from './AudiencePicker';
import { locationOptions } from './location-options';
import { OwnPublicGymWarning } from '../board-discovery/OwnPublicGymWarning';
import { Text } from '../Text';
import { Button } from '../Button';
import { SwitchRow } from '../SwitchRow';
import { useResourcePrivacy, useUpdateResourcePrivacy } from '../../lib/graphql/hooks/use-resource-privacy';
import { usePrivacySettings } from '../../lib/graphql/hooks/use-privacy';
import { useProfile } from '../../lib/graphql/hooks';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';
import { useTheme } from '../../providers/theme-provider';

export function ResourcePrivacyControl({
  kind,
  resourceId,
  gymUuid,
}: {
  kind: 'board' | 'session';
  resourceId: string;
  /** A board's gym: its location hint and the own-public-gym warning. */
  gymUuid?: string | null;
}) {
  const { t } = useTranslation('settings');
  const { t: tBoards } = useTranslation('boards');
  const { spacing, brandColors } = useTheme();
  const { data: profile } = useProfile();
  const { data: settings } = usePrivacySettings();
  const { data: privacy } = useResourcePrivacy(kind, resourceId);
  const update = useUpdateResourcePrivacy();
  const { effectiveOffline } = useConnectivity();
  if (!settings?.enabled || !privacy || privacy.ownerId !== profile?.id) return null;
  const disabled = effectiveOffline || update.isPending;
  const locationLabels: Record<PrivacyLocationAudience, string> = {
    only_me: t('privacy.audiences.onlyMe'),
    followers: t('privacy.audiences.followers'),
    members: t('privacy.locationInvited'),
    public: t('privacy.locationMembers'),
  };
  return (
    <View style={{ gap: spacing[3] }}>
      <AudiencePicker
        resource
        audience={privacy.audience}
        confirmPublic={settings.isPrivate}
        options={kind === 'board' ? BOARD_AUDIENCES : SESSION_AUDIENCES}
        disabled={disabled}
        label={kind === 'board' ? t('privacy.boardAudience') : t('privacy.postAudience')}
        onChange={(audience) => update.mutate({ kind, resourceId, audience })}
      />
      {kind === 'board' ? (
        <>
          <SwitchRow
            label={t('privacy.allowFollowers')}
            value={privacy.inheritFollowers}
            disabled={disabled}
            onValueChange={(inheritFollowers) =>
              update.mutate({ kind, resourceId, audience: privacy.audience, inheritFollowers })
            }
          />
          <Text variant="subheadline">{t('privacy.locationAudience')}</Text>
          {/* The choice always governs the board's own place. A viewer it is
              hidden from still sees a public gym's listed location. */}
          {gymUuid ? <Text>{tBoards('mobile.create.gymLocationHint')}</Text> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] }}>
            {locationOptions(privacy.locationAudience).map((option) => (
              <Button
                key={option}
                title={locationLabels[option]}
                variant={privacy.locationAudience === option ? 'filled' : 'outlined'}
                disabled={disabled}
                onPress={() =>
                  update.mutate({ kind, resourceId, audience: privacy.audience, locationAudience: option })
                }
              />
            ))}
          </View>
          <OwnPublicGymWarning gymUuid={gymUuid} />
        </>
      ) : null}
      <Button
        title={t('privacy.manageAccess')}
        variant="outlined"
        onPress={() => router.push({ pathname: '/settings/privacy-access', params: { kind, resourceId } })}
      />
      {effectiveOffline ? <Text>{t('privacy.offline')}</Text> : null}
      {update.isError ? (
        <Text accessibilityRole="alert" color={brandColors.error}>
          {t('privacy.saveFailed')}
        </Text>
      ) : null}
    </View>
  );
}
