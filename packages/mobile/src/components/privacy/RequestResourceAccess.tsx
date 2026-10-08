import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { Text } from '../Text';
import { usePrivacySettings } from '../../lib/graphql/hooks/use-privacy';
import { useResourceAccessAction } from '../../lib/graphql/hooks/use-resource-privacy';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';

export function RequestResourceAccess({ kind, resourceId }: { kind: 'board' | 'session'; resourceId: string }) {
  const { t } = useTranslation('settings');
  const { data: settings } = usePrivacySettings();
  const action = useResourceAccessAction();
  const { effectiveOffline } = useConnectivity();
  if (!settings?.enabled) return null;
  return (
    <View>
      <Button
        title={action.isSuccess ? t('privacy.requestSent') : t('privacy.requestAccess')}
        disabled={effectiveOffline || action.isPending || action.isSuccess}
        loading={action.isPending}
        onPress={() => action.mutate({ action: 'request', kind, resourceId })}
      />
      {action.isError ? <Text accessibilityRole="alert">{t('privacy.saveFailed')}</Text> : null}
    </View>
  );
}
