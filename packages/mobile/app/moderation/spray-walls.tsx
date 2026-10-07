import { Stack, router } from 'expo-router';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../src/components/Icon';
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
          headerLeft: ({ tintColor }) => (
            <Pressable
              onPress={() => router.back()}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={tCommon('ariaLabels.close')}
            >
              <Icon name="close" size={22} color={tintColor} />
            </Pressable>
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
