// "Share your beta" modal — the outbound half of the beta-video flow. It hands
// the climber a ready-to-paste, board-aware caption (with the climb name baked
// in so the share-back auto-match can recover the climb), copies it, opens
// Instagram to post the reel, and explains the share-sheet → Boardsesh step that
// brings the link back. A manual "already have a link?" paste field is kept at
// the bottom as a fallback (reuses the attachBetaLink mutation).
//
// Driven by a controlled `visible` prop (mirrors ClimbActionsSheet): the
// ModalSheet coordinator presents it above the play drawer's own native modal.
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import { BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { isBetaVideoUrl, isInstagramUrl, isTikTokUrl } from '@boardsesh/shared-schema';
import { buildInstagramCaption } from '@boardsesh/climb-actions';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { ModalSheet } from './ModalSheet';
import { Text } from './Text';
import { Button } from './Button';
import { SheetTopBar } from './SheetTopBar';
import { useSheetScrollIntoView } from './sheet-scroll-into-view';
import { openInstagram } from '../lib/instagram';
import { track } from '../lib/analytics';
import { useAttachBetaLink } from '../lib/graphql/hooks';
import { extractGraphqlMessage } from '../lib/graphql/extract-error-message';
import { useToast } from '../providers/toast-provider';
import { useTheme } from '../providers/theme-provider';
import { spacing, borderRadius } from '../theme/tokens';
import { textStyles } from '../theme/typography';
import { LARGE_SNAP_POINTS } from './sheet-snap-points';

type AddBetaVideoSheetProps = {
  visible: boolean;
  climb: Climb | null;
  boardName: BoardName;
  layoutId: number;
  angle: number;
  /** Request an animated close (pan-down, after submit). */
  onClose: () => void;
  /** Fired once the dismiss animation has settled — safe to unmount/clear.
   * Optional: always-mounted hosts (PlayDrawer) don't unmount, so they omit it. */
  onFullyDismissed?: () => void;
};

export function AddBetaVideoSheet({
  visible,
  climb,
  boardName,
  layoutId,
  angle,
  onClose,
  onFullyDismissed,
}: AddBetaVideoSheetProps) {
  const { t } = useTranslation('session');
  const { showToast } = useToast();
  const { systemColors } = useTheme();
  const [url, setUrl] = useState('');

  const attach = useAttachBetaLink();

  const caption = useMemo(() => {
    if (!climb) return '';
    return buildInstagramCaption({
      climbName: climb.name,
      angle,
      boardType: boardName,
      grade: climb.difficulty,
      setter: climb.setter_username,
      layoutId,
    });
  }, [climb, angle, boardName, layoutId]);

  const handleFullyDismissed = useCallback(() => {
    setUrl('');
    onFullyDismissed?.();
  }, [onFullyDismissed]);

  const handleCopyCaption = useCallback(async () => {
    if (!caption || !climb) return;
    await Clipboard.setStringAsync(caption);
    // The success toast below plays the success haptic; don't double it.
    track(SHARED_EVENTS.BetaCaptionCopied, { boardType: boardName, climbUuid: climb.uuid });
    showToast(t('mobile.betaVideos.captionCopied'), 'success');
  }, [caption, climb, boardName, showToast, t]);

  const handleOpenInstagram = useCallback(async () => {
    if (!climb) return;
    void Haptics.selectionAsync();
    // Copy the caption first so anyone who taps "Open Instagram" without hitting
    // "Copy caption" still lands in the camera with it on the clipboard. The old
    // web flow copied + opened atomically; keep that guarantee here.
    if (caption) await Clipboard.setStringAsync(caption);
    const { opened, usedFallback } = await openInstagram();
    track(SHARED_EVENTS.BetaInstagramOpened, { boardType: boardName, climbUuid: climb.uuid, opened, usedFallback });
    if (!opened) showToast(t('mobile.betaVideos.instagramOpenFailed'), 'error');
    else if (usedFallback) showToast(t('mobile.betaVideos.instagramNotInstalled'), 'info');
  }, [caption, climb, boardName, showToast, t]);

  const trimmed = url.trim();
  const hasInput = trimmed.length > 0;
  const isValid = hasInput && isBetaVideoUrl(trimmed);
  // Only nag once they've typed something that fails the pattern.
  const showError = hasInput && !isValid;

  const handleSubmit = useCallback(() => {
    if (!climb || !isValid || attach.isPending) return;
    attach.mutate(
      { boardType: boardName, climbUuid: climb.uuid, link: trimmed, angle },
      {
        onSuccess: () => {
          let platform: 'TikTok' | 'Instagram' | 'Unknown' = 'Unknown';
          if (isTikTokUrl(trimmed)) platform = 'TikTok';
          else if (isInstagramUrl(trimmed)) platform = 'Instagram';
          track(SHARED_EVENTS.BetaVideoAdded, { boardType: boardName, climbUuid: climb.uuid, platform });
          showToast(t('mobile.betaVideos.attachSuccess'), 'success');
          setUrl('');
          onClose();
        },
        onError: (error: unknown) => {
          showToast(extractGraphqlMessage(error) ?? t('mobile.betaVideos.attachError'), 'error');
        },
      },
    );
  }, [climb, isValid, attach, boardName, trimmed, angle, showToast, t, onClose]);

  // A form: large, so the field and its keyboard both fit (HIG Sheets).
  const snapPoints = LARGE_SNAP_POINTS;
  const submitDisabled = !isValid || attach.isPending;

  const header = (
    <SheetTopBar
      title={t('mobile.betaVideos.shareTitle')}
      leading={{ kind: 'cancel', onPress: onClose }}
      trailing={{
        kind: 'confirm',
        label: t('mobile.betaVideos.submitButton'),
        onPress: handleSubmit,
        disabled: submitDisabled,
        loading: attach.isPending,
        prominent: true,
      }}
    />
  );

  return (
    <ModalSheet
      visible={visible && !!climb}
      snapPoints={snapPoints}
      onClose={onClose}
      onFullyDismissed={handleFullyDismissed}
      scrollable
      header={header}
    >
      <View style={styles.container}>
        <StepRow index={1} title={t('mobile.betaVideos.step1Title')}>
          <View style={[styles.captionBox, { borderColor: systemColors.separator }]}>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {caption}
            </Text>
          </View>
          <Button
            title={t('mobile.betaVideos.copyCaption')}
            variant="filled"
            size="medium"
            icon="copy"
            disabled={!caption}
            onPress={handleCopyCaption}
            style={styles.actionButton}
          />
        </StepRow>

        <StepRow index={2} title={t('mobile.betaVideos.step2Title')}>
          <Button
            title={t('mobile.betaVideos.openInstagram')}
            variant="outlined"
            size="medium"
            icon="instagram"
            onPress={handleOpenInstagram}
            style={styles.actionButton}
          />
        </StepRow>

        <StepRow index={3} title={t('mobile.betaVideos.step3Title')}>
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {t('mobile.betaVideos.shareBackInstructions')}
          </Text>
        </StepRow>

        <View style={styles.pasteSection}>
          <View style={styles.divider}>
            <View style={[styles.dividerLine, { backgroundColor: systemColors.separator }]} />
            <Text variant="footnote" color={systemColors.tertiaryLabel}>
              {t('mobile.betaVideos.pasteSectionLabel')}
            </Text>
            <View style={[styles.dividerLine, { backgroundColor: systemColors.separator }]} />
          </View>

          <BetaUrlField value={url} invalid={showError} onChangeText={setUrl} onSubmit={handleSubmit} />
        </View>
      </View>
    </ModalSheet>
  );
}

type BetaUrlFieldProps = {
  value: string;
  /** Shows the invalid-URL message under the input. */
  invalid: boolean;
  onChangeText: (next: string) => void;
  onSubmit: () => void;
};

/** The paste field and its error. The wrapper scrolls above the keyboard, so
 *  the error clears it too. */
function BetaUrlField({ value, invalid, onChangeText, onSubmit }: BetaUrlFieldProps) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const fieldRef = useRef<View>(null);
  const scrollIntoView = useSheetScrollIntoView();
  const focusedRef = useRef(false);
  const handleFocus = useCallback(() => {
    focusedRef.current = true;
    if (fieldRef.current) scrollIntoView?.reveal(fieldRef.current);
  }, [scrollIntoView]);
  const handleBlur = useCallback(() => {
    focusedRef.current = false;
    if (fieldRef.current) scrollIntoView?.release(fieldRef.current);
  }, [scrollIntoView]);
  // The error line grows the wrapper after the focus reveal measured it, so
  // scroll again to keep the error above the keyboard. `follow`, not `reveal`:
  // it never moves the sheet's detent.
  const handleLayout = useCallback(() => {
    if (focusedRef.current && fieldRef.current) scrollIntoView?.follow(fieldRef.current);
  }, [scrollIntoView]);
  return (
    <View ref={fieldRef} style={styles.urlField} onLayout={handleLayout}>
      <BottomSheetTextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder={t('mobile.betaVideos.urlPlaceholder')}
        placeholderTextColor={systemColors.secondaryLabel}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="send"
        onSubmitEditing={onSubmit}
        style={[styles.input, { color: systemColors.label, borderColor: systemColors.separator }]}
      />
      {invalid && (
        <Text variant="footnote" color={brandColors.error}>
          {t('mobile.betaVideos.urlInvalid')}
        </Text>
      )}
    </View>
  );
}

type StepRowProps = {
  index: number;
  title: string;
  children?: ReactNode;
};

function StepRow({ index, title, children }: StepRowProps) {
  const { brandColors } = useTheme();
  return (
    <View style={styles.step}>
      <View style={styles.stepHeader}>
        <View style={[styles.stepBadge, { backgroundColor: brandColors.primaryFill }]}>
          <Text variant="footnote" color={brandColors.onPrimary} style={styles.stepBadgeText}>
            {index}
          </Text>
        </View>
        <Text variant="headline" style={styles.stepTitle}>
          {title}
        </Text>
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[6],
    gap: spacing[4],
  },
  step: {
    gap: spacing[2],
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  stepBadge: {
    width: 24,
    height: 24,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBadgeText: {
    fontWeight: '700',
  },
  stepTitle: {
    flex: 1,
  },
  captionBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.md,
    padding: spacing[3],
  },
  actionButton: {
    alignSelf: 'flex-start',
  },
  pasteSection: {
    gap: spacing[3],
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    fontSize: textStyles.callout.fontSize,
  },
  urlField: {
    gap: spacing[1],
  },
});
