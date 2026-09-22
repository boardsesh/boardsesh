import { memo, useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ONBOARDING_LINK_EMPTY_DISMISSED_KEY } from '@boardsesh/key-value-storage';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { reportError } from '../../lib/error-reporting';
import { dismissLinkEmptyPrompt, hasSeenTip } from '../../lib/onboarding/onboarding-storage';
import { hasNoLinkedBoardAccount, isLinkableBoard } from '../../lib/integrations/board-link-eligibility';
import { useBoardAccountCredentials } from '../../lib/integrations/use-board-account-credentials';
import { borderRadius, spacing } from '../../theme/tokens';

type BoardLinkPromptProps = {
  /** Only the profile's owner may be told to link *their* account. */
  viewerIsOwner: boolean;
  /** The climber has no sends at all. The card is meaningless otherwise. */
  hasNoSends: boolean;
};

/** Owner-only wayfinding; credentials and dismissal must be known before showing it. */
function BoardLinkPromptComponent({ viewerIsOwner, hasNoSends }: BoardLinkPromptProps) {
  const { t } = useTranslation('you');
  const { systemColors, brandColors } = useTheme();

  // Public profiles must not fetch the viewer's account credentials.
  const eligible = viewerIsOwner && hasNoSends;

  const { data: credentials } = useBoardAccountCredentials(eligible);
  const { data: activeBoard } = useActiveBoard();

  const [dismissed, setDismissed] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    void hasSeenTip(ONBOARDING_LINK_EMPTY_DISMISSED_KEY).then((seen) => {
      if (!cancelled) setDismissed(seen);
    });
    return () => {
      cancelled = true;
    };
  }, [eligible]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    dismissLinkEmptyPrompt().catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[board-link-prompt] Failed to persist dismissal', error);
      reportError(error);
    });
  }, []);

  const openConnectedApps = useCallback(() => {
    router.push('/(tabs)/profile/integrations');
  }, []);

  const unlinked = hasNoLinkedBoardAccount(credentials);
  // `undefined` on either read means "not known yet". Rendering optimistically
  // would flash a card at a climber who linked months ago.
  if (!eligible || dismissed !== false || unlinked !== true) return null;

  const boardType = activeBoard?.boardType;
  const isMoonBoard = boardType === 'moonboard';
  const linkable = isLinkableBoard(boardType);
  if (boardType && !isMoonBoard && !linkable) return null;
  const boardName = linkable ? boardTypeLabel(boardType) : '';

  // Static `t()` literals only — the linter hard-fails on `t(variable)` and the
  // orphan checker only sees literals, so each branch spells its own keys out.
  const title = isMoonBoard
    ? t('mobile.boardLink.moonboardTitle')
    : linkable
      ? t('mobile.boardLink.title', { boardName })
      : t('mobile.boardLink.titleGeneric');
  const body = isMoonBoard
    ? t('mobile.boardLink.moonboardBody')
    : linkable
      ? t('mobile.boardLink.body', { boardName })
      : t('mobile.boardLink.bodyGeneric');
  const cta = isMoonBoard
    ? t('mobile.boardLink.moonboardCta')
    : linkable
      ? t('mobile.boardLink.cta', { boardName })
      : t('mobile.boardLink.ctaGeneric');

  return (
    <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
      <View style={styles.heading}>
        <Icon name="link" size={20} color={brandColors.primary} />
        <Text variant="headline" style={styles.title}>
          {title}
        </Text>
      </View>
      <Text variant="subheadline" color={systemColors.secondaryLabel}>
        {body}
      </Text>
      <View style={styles.actions}>
        <Button title={cta} onPress={openConnectedApps} />
        <Button title={t('mobile.boardLink.dismiss')} variant="text" onPress={dismiss} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing[4],
    marginBottom: spacing[4],
    padding: spacing[4],
    borderRadius: borderRadius.lg,
    gap: spacing[2],
  },
  heading: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  title: { flexShrink: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[2], marginTop: spacing[2] },
});

export const BoardLinkPrompt = memo(BoardLinkPromptComponent);
