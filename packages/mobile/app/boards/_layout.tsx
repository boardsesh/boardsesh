import { Stack, router } from 'expo-router';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../src/components/Icon';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';

export default function BoardsLayout() {
  const { t } = useTranslation('common');
  const { t: tBoards } = useTranslation('boards');
  const screenOptions = useStackScreenOptions();

  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen
        name="index"
        options={{
          title: t('mobile.nav.boards'),
          // A modal now, not a tab: give it an explicit close button (iOS
          // swipe-to-dismiss alone isn't discoverable for a primary entry point).
          headerLeft: ({ tintColor }) => (
            <Pressable
              onPress={() => router.back()}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('ariaLabels.close')}
            >
              <Icon name="close" size={22} color={tintColor} />
            </Pressable>
          ),
        }}
      />
      {/* The full-screen board builder, pushed onto the boards stack (not a
          nested sheet): a back chevron is the drill-in affordance and there's no
          dueling pan-to-dismiss over the already-modal picker. */}
      <Stack.Screen name="create" options={{ title: tBoards('mobile.create.screenTitle') }} />
      {/* Manage your boards (edit / delete owned, unfollow followed) — distinct
          from the index picker, which only switches the active board. */}
      <Stack.Screen name="manage" options={{ title: t('myBoards.title') }} />
      <Stack.Screen name="edit" options={{ title: tBoards('mobile.edit.screenTitle') }} />
    </Stack>
  );
}
