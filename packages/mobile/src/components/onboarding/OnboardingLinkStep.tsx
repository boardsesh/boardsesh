import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { boardTypeLabel } from '@boardsesh/board-constants';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { Button } from '../Button';
import { Text } from '../Text';
import { GlassSurface } from '../GlassSurface';
import { OnboardingCard } from './OnboardingCard';
import { LinkBoardAccountModal } from '../integrations/LinkBoardAccountModal';
import { trackLinkPromptResolved, trackLinkPromptShown } from '../../lib/onboarding/link-step-analytics';
import { hapticSelection } from '../../lib/haptics';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants';
import { spacing } from '../../theme/tokens';

type OnboardingLinkStepProps = {
  /** The board bound in the previous step. Names the account being offered. */
  boardType: AuroraBoardName;
  accentColor: string;
  iconColor: string;
  bodyColor: string;
  backgroundColor: string;
  /** They answered — either way. Marks the step answered and leaves. */
  onResolved: () => void;
};

/**
 * The first-run "link your board account" card.
 *
 * **This is the one step in onboarding with a visible exit, and that is
 * deliberate.** Issue #4961 stripped the escape hatches out of the other three
 * because each guarantees state the app cannot run without — a bound board, a
 * chosen drawing — and a "look around first" that dropped climbers onto empty
 * screens was worse than no choice at all. This step is different in kind: it asks
 * for a password to somebody else's service, and nobody may be compelled to type
 * that. It also asks a question that is simply false for some people, because
 * there is no way to detect whether a board account exists — Aurora has no
 * lookup-by-email — so we can only ask.
 *
 * So: no `useBlockBack`. The route sets `gestureEnabled: false` for the whole
 * `/onboarding` file, which means "skippable" here has to be a real button rather
 * than a swipe, and Android hardware back reaches the same handler as "Not now".
 *
 * Every presentation resolves to exactly one outcome, including the nav-aways no
 * button produced — the unmount guard reports `abandoned`. Without it this would
 * repeat the hole `onboarding-analytics.ts` documents, where ~a third of tour
 * Starts resolved to nothing and quietly deflated the completion rate.
 */
export function OnboardingLinkStep({
  boardType,
  accentColor,
  iconColor,
  bodyColor,
  backgroundColor,
  onResolved,
}: OnboardingLinkStepProps) {
  const { t } = useTranslation('common');
  const insets = useSafeAreaInsets();
  const { variant } = useTheme();
  const [dialogOpen, setDialogOpen] = useState(false);
  const resolvedRef = useRef(false);

  useEffect(() => {
    trackLinkPromptShown(boardType);
    return () => {
      if (!resolvedRef.current) trackLinkPromptResolved(boardType, 'abandoned');
    };
  }, [boardType]);

  const boardName = boardTypeLabel(boardType);

  const openDialog = useCallback(() => {
    hapticSelection();
    setDialogOpen(true);
  }, []);

  // Declining is an answer, so it is recorded like one — the step does not come
  // back on the next launch. The empty-logbook prompt is what catches a climber
  // who says "not now" here and later wonders where their sends are.
  const decline = useCallback(() => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    trackLinkPromptResolved(boardType, 'declined');
    hapticSelection();
    onResolved();
  }, [boardType, onResolved]);

  // A successful link leaves immediately: the dialog already toasted, and holding
  // onboarding open while the sends trickle in would be a worse lie than leaving.
  const handleLinked = useCallback(() => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    trackLinkPromptResolved(boardType, 'linked');
    onResolved();
  }, [boardType, onResolved]);

  // Closing the dialog WITHOUT linking returns to the card rather than leaving —
  // a failed password is not a decision to skip, and dropping them out of
  // onboarding on a typo would be the worst possible reading of it.
  const closeDialog = useCallback(() => setDialogOpen(false), []);

  const footerPadding = useMemo(() => Math.max(insets.bottom, spacing[4]), [insets.bottom]);

  return (
    <View style={[styles.root, { backgroundColor, paddingTop: insets.top }]} accessibilityViewIsModal>
      <View style={styles.cardArea}>
        <OnboardingCard
          icon="link"
          title={t('mobile.onboarding.link.title', { boardName })}
          body={t('mobile.onboarding.link.body', { boardName })}
          footnote={t('mobile.onboarding.link.footnote', { boardName })}
          iconColor={iconColor}
          bodyColor={bodyColor}
        />
      </View>

      <GlassSurface glassEffectStyle="regular" style={[styles.footer, { paddingBottom: footerPadding }]}>
        <Button
          title={t('mobile.onboarding.link.continue', { boardName })}
          onPress={openDialog}
          variant="filled"
          size="large"
          tintColor={selectByVariant(variant, { material: undefined, liquidGlass: accentColor })}
          haptic={false}
          style={styles.primary}
        />
        <Button
          title={t('mobile.onboarding.link.skip')}
          onPress={decline}
          variant="text"
          size="large"
          haptic={false}
          style={styles.primary}
        />
        <Text variant="footnote" color={bodyColor} style={styles.skipHint}>
          {t('mobile.onboarding.link.skipHint')}
        </Text>
      </GlassSurface>

      <LinkBoardAccountModal
        boardType={dialogOpen ? boardType : null}
        source="onboarding"
        onClose={closeDialog}
        onLinked={handleLinked}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  cardArea: { flex: 1 },
  footer: {
    paddingTop: spacing[3],
    paddingHorizontal: spacing[5],
    gap: spacing[2],
  },
  primary: { alignSelf: 'stretch' },
  skipHint: { textAlign: 'center' },
});
