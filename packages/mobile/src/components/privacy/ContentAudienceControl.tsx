import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { PrivacyContentType } from '@boardsesh/graphql/operations/privacy';
import { AudiencePicker, SOCIAL_AUDIENCES } from './AudiencePicker';
import { Text } from '../Text';
import { useContentAudience } from '../../lib/graphql/hooks/use-resource-privacy';
import { usePrivacySettings, useSetContentAudience } from '../../lib/graphql/hooks/use-privacy';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';
import { useTheme } from '../../providers/theme-provider';

/** Reads the actual audience; never guesses that an existing post is public. */
export function ContentAudienceControl({ entityType, entityId }: { entityType: PrivacyContentType; entityId: string }) {
  const { t } = useTranslation('settings');
  const { brandColors } = useTheme();
  const { data: settings } = usePrivacySettings();
  const { data: saved } = useContentAudience(entityType, entityId);
  const update = useSetContentAudience();
  const { effectiveOffline } = useConnectivity();
  if (!settings?.enabled || !saved) return null;
  if (!saved.canEdit) return null;
  return (
    <View>
      <AudiencePicker
        audience={saved.audience}
        options={SOCIAL_AUDIENCES}
        confirmPublic={settings.isPrivate}
        disabled={effectiveOffline || update.isPending}
        onChange={(audience) =>
          update.mutate({ entityType, entityId, audience, privacyRevision: settings.privacyRevision })
        }
      />
      {update.isError ? (
        <Text accessibilityRole="alert" color={brandColors.error}>
          {t('privacy.saveFailed')}
        </Text>
      ) : null}
    </View>
  );
}
