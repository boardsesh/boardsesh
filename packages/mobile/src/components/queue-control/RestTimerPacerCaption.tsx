// Who paces the crew's rest timer (#5382): "Sam is pacing the wall", "You're
// pacing the wall", "Nobody is holding the board". One line under the pill's
// digits and the sheet's clock while this phone follows a crew clock that
// moves the wall.
//
// Its own memoized leaf, outside the 1 Hz clock: it reads the crew clock's
// config and the wall-driver rule, which change when the board changes hands,
// never on a tick. And nothing here mounts the driver rule's hooks until a crew
// clock is there, so a solo timer pays for one store read.

import { memo } from 'react';
import { StyleSheet, type StyleProp, type TextStyle } from 'react-native';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useCrewRestConfig } from '../../hooks/use-effective-rest-pacing';
import { useSessionTimerDriver } from '../../hooks/use-session-timer-driver';
import type { WallDriverRole } from '../../lib/session-timer/driver-rule';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';

/** The line for a role, or null when there is nothing to say (no crew around). */
export function restTimerPacerCaption(
  role: WallDriverRole,
  pacerDisplayName: string | null,
  t: TFunction<'session'>,
): string | null {
  switch (role) {
    case 'solo':
      return null;
    case 'holder':
      return t('mobile.restTimer.crew.pacedByYou');
    case 'passenger':
      return pacerDisplayName
        ? t('mobile.restTimer.crew.pacedByName', { name: pacerDisplayName })
        : t('mobile.restTimer.crew.pacedByCrewmate');
    case 'unheld':
      return t('mobile.restTimer.crew.unheld');
  }
}

/**
 * The auto-advance switch's line while a crew clock runs: whose phone moves the
 * wall for everyone. Null outside a crew, where the switch keeps its own hint.
 */
export function restTimerCrewAutoAdvanceDescription(
  role: WallDriverRole,
  pacerDisplayName: string | null,
  t: TFunction<'session'>,
): string | null {
  switch (role) {
    case 'solo':
      return null;
    case 'holder':
      return t('mobile.restTimer.crew.autoAdvanceByYou');
    case 'passenger':
      return pacerDisplayName
        ? t('mobile.restTimer.crew.autoAdvanceByName', { name: pacerDisplayName })
        : t('mobile.restTimer.crew.autoAdvanceByCrewmate');
    case 'unheld':
      return t('mobile.restTimer.crew.autoAdvanceUnheld');
  }
}

type RestTimerPacerCaptionProps = {
  variant?: 'footnote' | 'subheadline';
  /** Center it under the sheet's clock; the pill keeps its row alignment. */
  centered?: boolean;
  style?: StyleProp<TextStyle>;
};

export const RestTimerPacerCaption = memo(function RestTimerPacerCaption(props: RestTimerPacerCaptionProps) {
  const crewConfig = useCrewRestConfig();
  // Only a crew clock that moves the wall has a pacer worth naming.
  if (crewConfig === null || !crewConfig.autoAdvance || crewConfig.targetSeconds === null) return null;
  return <CrewPacerLine {...props} />;
});

function CrewPacerLine({ variant = 'footnote', centered = false, style }: RestTimerPacerCaptionProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const { role, pacerDisplayName } = useSessionTimerDriver();
  const caption = restTimerPacerCaption(role, pacerDisplayName, t);
  if (caption === null) return null;
  return (
    <Text
      variant={variant}
      color={systemColors.secondaryLabel}
      maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
      numberOfLines={1}
      style={[centered ? styles.centered : null, style]}
      testID="rest-timer-pacer-caption"
    >
      {caption}
    </Text>
  );
}

const styles = StyleSheet.create({
  centered: {
    textAlign: 'center',
  },
});
