import { scopedRouter as router } from '../../lib/routing/scoped-navigation';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AudiencePicker, BOARD_AUDIENCES, SESSION_AUDIENCES } from './AudiencePicker';
import { Text } from '../Text';
import { Button } from '../Button';
import { SwitchRow } from '../SwitchRow';
import { useResourcePrivacy, useUpdateResourcePrivacy } from '../../lib/graphql/hooks/use-resource-privacy';
import { usePrivacySettings } from '../../lib/graphql/hooks/use-privacy';
import { useProfile } from '../../lib/graphql/hooks';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';
import { useTheme } from '../../providers/theme-provider';

export function ResourcePrivacyControl({ kind, resourceId }: { kind: 'board' | 'session'; resourceId: string }) {
  const { t } = useTranslation('settings');
  const { spacing, brandColors } = useTheme();
  const { data: profile } = useProfile();
  const { data: settings } = usePrivacySettings();
  const { data: privacy } = useResourcePrivacy(kind, resourceId);
  const update = useUpdateResourcePrivacy();
  const { effectiveOffline } = useConnectivity();
  if (!settings?.enabled || !privacy || privacy.ownerId !== profile?.id) return null;
  const disabled = effectiveOffline || update.isPending;
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
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] }}>
            <Button
              title={t('privacy.audiences.onlyMe')}
              variant={privacy.locationAudience === 'only_me' ? 'filled' : 'outlined'}
              disabled={disabled}
              onPress={() =>
                update.mutate({ kind, resourceId, audience: privacy.audience, locationAudience: 'only_me' })
              }
            />
            <Button
              title={t('privacy.audiences.followers')}
              variant={privacy.locationAudience === 'followers' ? 'filled' : 'outlined'}
              disabled={disabled}
              onPress={() =>
                update.mutate({ kind, resourceId, audience: privacy.audience, locationAudience: 'followers' })
              }
            />
            <Button
              title={t('privacy.locationInvited')}
              variant={privacy.locationAudience === 'members' ? 'filled' : 'outlined'}
              disabled={disabled}
              onPress={() =>
                update.mutate({ kind, resourceId, audience: privacy.audience, locationAudience: 'members' })
              }
            />
            <Button
              title={t('privacy.locationMembers')}
              variant={privacy.locationAudience === 'public' ? 'filled' : 'outlined'}
              disabled={disabled}
              onPress={() =>
                update.mutate({ kind, resourceId, audience: privacy.audience, locationAudience: 'public' })
              }
            />
          </View>
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
