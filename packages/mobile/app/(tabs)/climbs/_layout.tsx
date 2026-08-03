import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useStackScreenOptions } from '../../../src/hooks/use-stack-screen-options';
import { NativeTabContentInsetProbe } from '../../../src/components/navigation/NativeTabContentInsetProbe';
import { BoardArtVisibilityProvider } from '../../../src/providers/board-art-visibility-provider';

export default function ClimbsLayout() {
  const { t } = useTranslation('common');
  const screenOptions = useStackScreenOptions();

  return (
    <BoardArtVisibilityProvider tab="climbs">
      <NativeTabContentInsetProbe />
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
            // Full-screen interactive board for the hold-type filter (a pushed route,
            // not a modal, so the board's pan/pinch never competes with a modal's
            // pan). The native stack header carries the title + back chevron; "Clear
            // all" is a headerRight (set per-screen). Opaque, not the app's glass push
            // header, so the board lays out below the bar (mirrors users/[userId]).
            title: t('mobile.nav.holdFilter'),
            headerTransparent: false,
          }}
        />
        <Stack.Screen
          name="zone"
          options={{
            // Full-screen interactive board for the board-region (zone) filter. Same
            // as the hold filter: native header (title + back chevron), opaque so the
            // board sits below the bar, headerRight "Clear all" set per-screen.
            title: t('mobile.nav.zoneFilter'),
            headerTransparent: false,
          }}
        />
        <Stack.Screen
          name="setters"
          options={{
            // Setter search/multi-select for the climb filter. A pushed route (not a
            // stacked sheet) because native sheets can't stack above the filter sheet.
            // Native header (title + back chevron), opaque so the search bar sits below
            // the bar; headerRight "Clear all" set per-screen.
            title: t('mobile.nav.setters'),
            headerTransparent: false,
          }}
        />
      </Stack>
    </BoardArtVisibilityProvider>
  );
}
