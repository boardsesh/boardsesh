// The moderation feed, as ONE root-stack modal rather than a copy per tab.
//
// Three surfaces link here — the More tab's Community row, a `proposal_*`
// notification from either tab, and the play drawer's Community section — and
// the last one is why the route lives at the root. `/play` is itself a root
// `transparentModal`, so a push aimed at a tab stack lands BENEATH the player:
// a dead tap and a screen nobody can reach (docs/mobile-sheets-vs-routes.md,
// "Pushing a route from INSIDE a modal route"). A root `modal` card presents
// above whatever is already open, so one route serves all three.
//
// Deep links: a notification about a proposal lands here with that proposal's
// uuid. If it is in the loaded pages the list scrolls to it and outlines it; if
// it isn't (it's page 6 of the queue) the climb's own proposals are fetched and
// the matching one is pinned above the feed.
//
// The `climb-moderation-kill` switch is enforced INSIDE `ModerationFeedScreen`,
// not here: a notification sent before the takedown still opens this route, and
// a screen that says so beats a route that 404s or a queue nobody can act on.
// Keeping the gate in the screen also covers any future host of it.

import { Stack, router, useLocalSearchParams } from 'expo-router';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../src/components/Icon';
import { ModerationFeedScreen } from '../src/components/moderation/ModerationFeedScreen';
import { useStackScreenOptions } from '../src/hooks/use-stack-screen-options';

type Params = {
  /** Proposal to scroll to and outline (from a notification or the play drawer). */
  proposalUuid?: string;
  climbUuid?: string;
  boardType?: string;
};

export default function ModerationRoute() {
  const params = useLocalSearchParams<Params>();
  const { t } = useTranslation('common');
  const { t: tClimbs } = useTranslation('climbs');
  // Variant-aware header from the shared hook, the same way about/changelog/scout
  // title themselves: a transparent blur header on Liquid Glass, an opaque M3 app
  // bar on Material.
  const screenOptions = useStackScreenOptions();

  return (
    <>
      <Stack.Screen
        options={{
          ...screenOptions,
          title: tClimbs('mobile.moderation.title'),
          headerShown: true,
          // Same call the boards picker makes: a modal reached from three
          // different surfaces needs a visible way out, not only the iOS
          // swipe-down.
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
      <ModerationFeedScreen
        highlightProposalUuid={params.proposalUuid}
        climbUuid={params.climbUuid}
        boardType={params.boardType}
      />
    </>
  );
}
