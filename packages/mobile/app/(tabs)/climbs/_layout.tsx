import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useStackScreenOptions } from '../../../src/hooks/use-stack-screen-options';

export default function ClimbsLayout() {
  const { t } = useTranslation('common');
  const screenOptions = useStackScreenOptions();

  return (
    <Stack screenOptions={screenOptions}>
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
          // The climb page is now a thin redirector: it loads the climb by uuid,
          // opens it in the play drawer, then pops. It only ever flashes a
          // spinner, so it has no header.
          headerShown: false,
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
