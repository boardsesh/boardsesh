import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { boardDemandReported, type BoardDemandReason, type BoardDemandSurface } from '@boardsesh/analytics';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { ModalSheet } from '../ModalSheet';
import { useTheme } from '../../providers/theme-provider';
import { withAlpha } from '../../theme/colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { boardDemandNeedsFeedback } from '../../lib/boards/board-demand-flow';
import { track } from '../../lib/analytics';
import { useUserDrawer } from '../user-drawer/UserDrawerProvider';

type BoardDemandSheetProps = {
  visible: boolean;
  /** Which surface handed the form over; recorded on every event. */
  surface: BoardDemandSurface;
  onClose: () => void;
};

/**
 * "Can't find your board?" — the unmet-demand form (issue #6062).
 *
 * One closed question with five answers. There is deliberately no free-text
 * box here: what the climber can say in words (which gym, which brand) belongs
 * to the feedback pipeline, not to PostHog, so the three reasons that imply a
 * nameable board hand straight to the bug-mode sheet after firing the count.
 * `spray_wall` and `no_board_yet` are feature asks; the event is the whole
 * record and the sheet says so and closes.
 *
 * The event fires on SEND, once, never per tap — see `boardDemandReported`.
 */
export function BoardDemandSheet({ visible, surface, onClose }: BoardDemandSheetProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const { setFeedbackMode, presentFeedback } = useUserDrawer();
  const [reason, setReason] = useState<BoardDemandReason | null>(null);
  // The non-feedback branches need their own settle state; the feedback ones
  // hand the user to the next sheet and are done on close.
  const [sent, setSent] = useState(false);

  // A sheet that was dismissed mid-fill starts empty next time.
  useEffect(() => {
    if (!visible) {
      setReason(null);
      setSent(false);
    }
  }, [visible]);

  // Written out, not built from an array: the linter (and the catalog test)
  // want literal keys, and five options is not worth a registry.
  const options: { id: BoardDemandReason; label: string }[] = [
    { id: 'gym_board_not_listed', label: t('mobile.demand.gymBoardNotListed') },
    { id: 'unsupported_brand', label: t('mobile.demand.unsupportedBrand') },
    { id: 'spray_wall', label: t('mobile.demand.sprayWall') },
    { id: 'no_board_yet', label: t('mobile.demand.noBoardYet') },
    { id: 'other', label: t('mobile.demand.other') },
  ];

  const onSubmit = () => {
    if (!reason) return;
    const payload = boardDemandReported(reason, surface);
    track(payload.name, payload.properties);
    if (boardDemandNeedsFeedback(reason)) {
      // Hand off: the count is fired, the words go to the feedback sheet. The
      // presentation coordinator serializes the two sheet transitions.
      setFeedbackMode('bug');
      presentFeedback();
      onClose();
      return;
    }
    setSent(true);
  };

  const footer = sent ? (
    <Button title={t('mobile.demand.done')} variant="filled" size="large" onPress={onClose} />
  ) : (
    <Button
      title={t('mobile.demand.send')}
      variant="filled"
      size="large"
      disabled={reason === null}
      onPress={onSubmit}
    />
  );

  return (
    <ModalSheet visible={visible} snapPoints={['50%', '90%']} onClose={onClose} scrollable footer={footer}>
      <View style={styles.body}>
        {sent ? (
          <>
            <Text variant="title2" accessibilityRole="header">
              {t('mobile.demand.thanksTitle')}
            </Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {t('mobile.demand.thanksBody')}
            </Text>
          </>
        ) : (
          <>
            <Text variant="title2" accessibilityRole="header">
              {t('mobile.demand.title')}
            </Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {t('mobile.demand.body')}
            </Text>
            <View style={styles.options}>
              {options.map((option) => {
                const selected = reason === option.id;
                return (
                  <Pressable
                    key={option.id}
                    onPress={() => setReason(option.id)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    style={[
                      styles.option,
                      {
                        borderColor: selected ? brandColors.primary : systemColors.separator,
                        backgroundColor: selected
                          ? withAlpha(brandColors.primary, 0.08)
                          : systemColors.secondaryBackground,
                      },
                    ]}
                  >
                    <Text variant="body" style={styles.optionLabel}>
                      {option.label}
                    </Text>
                    {selected ? <Icon name="check.small" size={18} color={brandColors.primary} /> : null}
                  </Pressable>
                );
              })}
            </View>
          </>
        )}
      </View>
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    gap: spacing[3],
  },
  options: {
    gap: spacing[2],
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  optionLabel: {
    flex: 1,
  },
});
