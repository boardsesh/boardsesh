import { Stack, router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { HeaderLeadingButton } from '../../src/components/HeaderActionButtons';
import { SprayWallReportsScreen } from '../../src/components/moderation/SprayWallReportsScreen';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';
import { holdUntilLaunchReady } from '../../src/components/launch-update/hold-until-launch-ready';

function SprayWallReportsRoute() {
  const { t } = useTranslation('boards');
  const { t: tCommon } = useTranslation('common');
  const screenOptions = useStackScreenOptions();
  return (
    <>
      <Stack.Screen
        options={{
          ...screenOptions,
          title: t('sprayModeration.queueTitle'),
          headerShown: true,
          headerLeft: () => (
            <HeaderLeadingButton
              kind="close"
              onPress={() => router.back()}
              accessibilityLabel={tCommon('ariaLabels.close')}
            />
          ),
        }}
      />
      <SprayWallReportsScreen />
    </>
  );
}

// iOS presents this route as a native modal, above the launch update
// placeholder, and a URL can open it on a cold start. Held until launch is
// ready so a gate reload cannot land mid-tap (#6006).
export default holdUntilLaunchReady(SprayWallReportsRoute, { header: 'visible' });
