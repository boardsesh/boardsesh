import { Stack } from 'expo-router';
import { Platform } from 'react-native';
import { useTranslation } from 'react-i18next';

export default function ClimbsLayout() {
  const { t } = useTranslation('common');

  return (
    <Stack
      screenOptions={{
        headerLargeTitle: false,
        // Transparent blur header is an iOS idiom — there, the list's
        // contentInsetAdjustmentBehavior="automatic" insets content below it. On
        // Android that prop is a no-op and, under mandatory edge-to-edge, content
        // draws under the floating header + status bar (the search bar overlapped
        // the first row). A solid header lays the scene out below it correctly.
        headerTransparent: Platform.OS === 'ios',
        headerBlurEffect: 'systemMaterial',
        contentStyle: { backgroundColor: 'transparent' },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: t('mobile.nav.climbs'),
          // The climb list owns its own floating glass search row, so it hides
          // the native header (which otherwise occluded the in-body controls).
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="[climbUuid]"
        options={{
          title: t('mobile.nav.climb'),
        }}
      />
      <Stack.Screen
        name="setters"
        options={{
          title: t('mobile.nav.setters'),
          presentation: 'modal',
        }}
      />
      <Stack.Screen
        name="create"
        options={{
          // The create UI is just the drawer floating over the climbs/search
          // list — a transparent, headerless modal (no separate card around it).
          headerShown: false,
          presentation: 'transparentModal',
          animation: 'fade',
        }}
      />
      <Stack.Screen
        name="holds"
        options={{
          // Full-screen interactive board for the hold-type filter. Owns its own
          // header (Done / Clear all), and the board gestures need the full card,
          // so the native header is hidden and it's a pushed route (not a modal,
          // which would compete with the board's pan/pinch).
          title: t('mobile.nav.holdFilter'),
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="zone"
        options={{
          // Full-screen interactive board for the board-region (zone) filter.
          // Like the hold filter: owns its own header and a pushed route so the
          // board's drag/pinch never competes with a modal sheet's pan.
          title: t('mobile.nav.zoneFilter'),
          headerShown: false,
        }}
      />
    </Stack>
  );
}
