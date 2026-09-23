import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { OnboardingLinkStep } from './OnboardingLinkStep';
import { isLinkableBoard } from '../../lib/integrations/board-link-eligibility';
import { markLinkStepAnswered } from '../../lib/onboarding/link-step-answered';
import { useFeatureFlag } from '../../providers/feature-flags-provider';
import { reportError } from '../../lib/error-reporting';

// The optional link step owns its answer marker and navigation.
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
  const enabled = useFeatureFlag('board-link-onboarding-step') === true;
  const [leaving, setLeaving] = useState(false);

  const leave = useCallback(() => {
    setLeaving(true);
    router.dismissTo('/(tabs)/climbs');
  }, []);

  // Persist answers only; leaving without answering keeps the prompt eligible.
  const resolve = useCallback(() => {
    markLinkStepAnswered().catch((error: unknown) => {
      reportError(error);
    });
    leave();
  }, [leave]);

  const linkable = enabled && isLinkableBoard(boardType);

  // Direct navigation must respect the same rollout and supported-board gates.
  useEffect(() => {
    if (!linkable) leave();
  }, [linkable, leave]);

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
