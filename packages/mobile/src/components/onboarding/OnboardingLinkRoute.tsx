import { useCallback, useEffect, useState } from 'react';
import { BackHandler, View } from 'react-native';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { OnboardingLinkStep } from './OnboardingLinkStep';
import { isLinkableBoard } from '../../lib/integrations/board-link-eligibility';
import { markLinkStepAnswered } from '../../lib/onboarding/link-step-answered';
import { reportError } from '../../lib/error-reporting';

/**
 * The link step's data and exits.
 *
 * Its own component, like `BoardLookRoute`, so nothing it needs is mounted while a
 * different step is on screen.
 *
 * The board comes from the route param rather than a query: the previous step
 * bound it moments ago and passed it along, so there is nothing to look up and no
 * loading state to render. A deep link straight to `?step=link` without a usable
 * board type leaves rather than showing a card about no board in particular.
 */
export function OnboardingLinkRoute({
  accentColor,
  iconColor,
  bodyColor,
  backgroundColor,
}: {
  accentColor: string;
  iconColor: string;
  bodyColor: string;
  backgroundColor: string;
}) {
  const { boardType } = useLocalSearchParams<{ boardType?: string }>();
  const isFocused = useIsFocused();
  const [leaving, setLeaving] = useState(false);

  const leave = useCallback(() => {
    setLeaving(true);
    // `replace`, not `dismissTo`: onboarding is a full-screen cover with nothing
    // of its own left to return to, and the board-look gate picks the climber up
    // on Climbs — the same exit the board step takes.
    router.replace('/(tabs)/climbs');
  }, []);

  // Written on an ANSWER, never on arrival, mirroring `markBoardLookStepSeen`:
  // a force-quit mid-step must leave the question live for the next launch rather
  // than burning it in silence.
  const resolve = useCallback(() => {
    markLinkStepAnswered().catch((error: unknown) => {
      // Failing to record the answer only costs one extra ask later, so it must
      // never block the exit.
      reportError(error);
    });
    leave();
  }, [leave]);

  const linkable = isLinkableBoard(boardType);

  // Deep-linked here with no linkable board (the gate never does this, but the
  // route is reachable on its own): there is no account to offer, so leave rather
  // than show a card naming nothing.
  useEffect(() => {
    if (!linkable) leave();
  }, [linkable, leave]);

  // Android hardware back resolves as "not now" rather than being swallowed. This
  // step deliberately does NOT call `useBlockBack` — see OnboardingLinkStep for
  // why it is the one escapable screen in the flow — but back must still count as
  // an answer, or a climber could reach Climbs with the question left live and be
  // asked again on the next launch.
  useEffect(() => {
    if (!isFocused || !linkable) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      resolve();
      return true;
    });
    return () => subscription.remove();
  }, [isFocused, linkable, resolve]);

  if (!linkable || leaving) return <View style={{ flex: 1, backgroundColor }} />;

  return (
    <OnboardingLinkStep
      boardType={boardType as AuroraBoardName}
      accentColor={accentColor}
      iconColor={iconColor}
      bodyColor={bodyColor}
      backgroundColor={backgroundColor}
      onResolved={resolve}
    />
  );
}
