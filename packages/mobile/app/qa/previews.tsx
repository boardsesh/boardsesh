import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { QaPickScreen } from '../../src/components/qa/QaPickScreen';
import { holdUntilLaunchReady } from '../../src/components/launch-update/hold-until-launch-ready';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';

function QaPreviewsRoute() {
  const { t } = useTranslation('common');
  const screenOptions = useStackScreenOptions();
  return (
    <>
      <Stack.Screen
        options={{
          ...screenOptions,
          title: t('qa.pick.title'),
          headerShown: true,
          headerTransparent: false,
          presentation: 'card',
        }}
      />
      <QaPickScreen presentation="page" />
    </>
  );
}

export default holdUntilLaunchReady(QaPreviewsRoute);
