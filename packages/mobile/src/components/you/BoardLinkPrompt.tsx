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
import { hasSeenTip, markTipSeen } from '../../lib/onboarding/onboarding-storage';
import { hasNoLinkedBoardAccount, isLinkableBoard } from '../../lib/integrations/board-link-eligibility';
import { useBoardAccountCredentials } from '../../lib/integrations/use-board-account-credentials';
import { borderRadius, spacing } from '../../theme/tokens';

type BoardLinkPromptProps = {
  /** Only the profile's owner may be told to link *their* account. */
  viewerIsOwner: boolean;
  /** The climber has no sends at all. The card is meaningless otherwise. */
  hasNoSends: boolean;
};

/**
 * "Your logbook is empty because your board account isn't linked."
 *
 * This is the branch that never existed. A climber arriving from Kilter or Tension
 * with hundreds of logged sends lands on an empty Progress tab reading "Nothing
 * logged yet — your stats show up once you start ticking climbs", which is exactly
 * the wrong advice: their history is one link away, not one session away. The one
 * string in the app that mentioned importing lives on the `hasAscents` side of a
 * guard in `ProgressTab` — correctly, since its copy opens "Your sends chart out
 * here" — so nothing at all fired for the empty case.
 *
 * Deliberately routes to Connected apps rather than opening a credential form
 * inline. The reported failure was wayfinding: the climber could not find the
 * screen, and found it instantly once pointed at it. Landing them on it is the
 * whole fix, and it keeps a third-party password prompt out of a surface they did
 * not ask for.
 *
 * Shows only when we can prove all three: the viewer owns this profile, they have
 * no sends, and they have no linked board account. The third is a tri-state, not a
 * boolean — see `hasNoLinkedBoardAccount`.
 */
function BoardLinkPromptComponent({ viewerIsOwner, hasNoSends }: BoardLinkPromptProps) {
  const { t } = useTranslation('you');
  const { systemColors, brandColors } = useTheme();

  // Nothing is fetched, read or rendered for a climber this card can't apply to —
  // a stranger's profile must not pay for a query about the viewer's own accounts.
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
    void markTipSeen(ONBOARDING_LINK_EMPTY_DISMISSED_KEY);
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
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.body}>
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
  body: {},
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], marginTop: spacing[2] },
});

export const BoardLinkPrompt = memo(BoardLinkPromptComponent);
