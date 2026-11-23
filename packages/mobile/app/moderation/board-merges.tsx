import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { HeaderLeadingButton } from '../../src/components/HeaderActionButtons';
import { BoardMergesScreen } from '../../src/components/moderation/BoardMergesScreen';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';
import { holdUntilLaunchReady } from '../../src/components/launch-update/hold-until-launch-ready';

function BoardMergesRoute() {
  const { boardUuid, gymUuid } = useLocalSearchParams<{ boardUuid?: string; gymUuid?: string }>();
  const { t } = useTranslation('boards');
  const { t: tCommon } = useTranslation('common');
  const screenOptions = useStackScreenOptions();
  return (
    <>
      <Stack.Screen
        options={{
          ...screenOptions,
          title: t('merge.title'),
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
      <BoardMergesScreen boardUuid={boardUuid} gymUuid={gymUuid} />
    </>
  );
}

// iOS presents this route as a native modal, above the launch update
// placeholder, and a URL can open it on a cold start. Held until launch is
// ready so a gate reload cannot land mid-tap (#6006).
export default holdUntilLaunchReady(BoardMergesRoute, { header: 'visible' });
