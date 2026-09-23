import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
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

// Optional account linking resolves once per presentation, including navigation away.
export function OnboardingLinkStep({
  boardType,
  accentColor,
  iconColor,
  bodyColor,
  backgroundColor,
  onResolved,
}: OnboardingLinkStepProps) {
  const { t } = useTranslation('common');
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { variant } = useTheme();
  const [dialogOpen, setDialogOpen] = useState(false);
  const resolvedRef = useRef(false);

  useEffect(() => {
    resolvedRef.current = false;
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

  // A decline completes this optional step; linking remains available in Settings.
  const decline = useCallback(() => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    trackLinkPromptResolved(boardType, 'declined');
    hapticSelection();
    onResolved();
  }, [boardType, onResolved]);

  // Sync may continue after the account is linked.
  const handleLinked = useCallback(() => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    trackLinkPromptResolved(boardType, 'linked');
    onResolved();
  }, [boardType, onResolved]);

  // Closing the credential dialog leaves the optional question unanswered.
  const closeDialog = useCallback(() => setDialogOpen(false), []);

  useEffect(() => {
    if (!isFocused) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (dialogOpen) closeDialog();
      else decline();
      return true;
    });
    return () => subscription.remove();
  }, [isFocused, dialogOpen, closeDialog, decline]);

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
