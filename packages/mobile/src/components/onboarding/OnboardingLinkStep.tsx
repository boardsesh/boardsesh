import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { boardTypeLabel } from '@boardsesh/board-constants';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { SheetTopBar } from '../SheetTopBar';
import { Text } from '../Text';
import { OnboardingCard } from './OnboardingCard';
import { LinkBoardAccountModal } from '../integrations/LinkBoardAccountModal';
import { trackLinkPromptResolved, trackLinkPromptShown } from '../../lib/onboarding/link-step-analytics';
import { hapticSelection } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';

type OnboardingLinkStepProps = {
  /** The board bound in the previous step. Names the account being offered. */
  boardType: AuroraBoardName;
  iconColor: string;
  bodyColor: string;
  backgroundColor: string;
  /** They answered — either way. Marks the step answered and leaves. */
  onResolved: () => void;
};

// Optional account linking resolves once per presentation, including navigation away.
export function OnboardingLinkStep({
  boardType,
  iconColor,
  bodyColor,
  backgroundColor,
  onResolved,
}: OnboardingLinkStepProps) {
  const { t } = useTranslation('common');
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
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

  // The route hides the native header (a transparentModal), so the step draws
  // its own top bar: "Not now" leading, where iOS puts a decline, and the link
  // as the trailing confirm.
  return (
    <View
      style={[
        styles.root,
        { backgroundColor, paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, spacing[4]) },
      ]}
      accessibilityViewIsModal
    >
      <SheetTopBar
        title=""
        leading={{ kind: 'cancel', label: t('mobile.onboarding.link.skip'), onPress: decline }}
        trailing={{
          label: t('mobile.onboarding.link.continue', { boardName }),
          onPress: openDialog,
          prominent: true,
        }}
      />
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

      <Text variant="footnote" color={bodyColor} style={styles.skipHint}>
        {t('mobile.onboarding.link.skipHint')}
      </Text>

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
  skipHint: { textAlign: 'center', paddingHorizontal: spacing[5] },
});
