import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { AudiencePicker, SOCIAL_AUDIENCES } from './AudiencePicker';
import type { usePublicationAudience } from './use-publication-audience';
export function PublicationAudiencePicker({
  privacy,
  disabled,
}: {
  privacy?: ReturnType<typeof usePublicationAudience>;
  disabled?: boolean;
}) {
  const { t } = useTranslation('settings');
  if (!privacy?.enabled) return null;
  return (
    <View>
      {privacy.revisionChanged ? <Text accessibilityRole="alert">{t('privacy.revisionChanged')}</Text> : null}
      <AudiencePicker
        audience={privacy.audience}
        options={SOCIAL_AUDIENCES}
        onChange={privacy.chooseAudience}
        confirmPublic={privacy.isPrivate}
        reconfirmPublic={privacy.revisionChanged}
        disabled={disabled}
      />
    </View>
  );
}
