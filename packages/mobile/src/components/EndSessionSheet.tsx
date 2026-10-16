import { AccessibleBottomSheetTextInput as BottomSheetTextInput } from './AccessibleBottomSheetTextInput';
import { useTypographyStyles, type TypographyScale } from '../hooks/use-typography-styles';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { ModalSheet } from './ModalSheet';
import { MEDIUM_LARGE_SNAP_POINTS } from './sheet-snap-points';
import { useTranslation } from 'react-i18next';
import { SESSION_NOTES_MAX_LENGTH } from '@boardsesh/shared-schema';
import { Text } from './Text';
import { Button } from './Button';
import { Icon } from './Icon';
import { SheetTopBar } from './SheetTopBar';
import { useTheme } from '../providers/theme-provider';
import { spacing, borderRadius } from '../theme/tokens';
import type { SessionExitMode } from './session-screen/use-session-exit-options';

type EndSessionSheetProps = {
  visible: boolean;
  onDismiss: () => void;
  onConfirm: () => void;
  /** Drop out of the session without ending it for anyone else. */
  onLeave: () => void;
  isEnding: boolean;
  isLeaving: boolean;
  climbCount: number;
  /** Current recap text. Optional — an empty field never blocks or validates End. */
  notes: string;
  onNotesChange: (text: string) => void;
  /**
   * Which action the sheet opens on. The other stays one tap away via the
   * switch link below the buttons, so this is emphasis, never availability.
   */
  defaultMode: SessionExitMode;
  /** Whether to offer "end for everyone" at all (false for a known non-creator). */
  canEnd: boolean;
};

/**
 * The session exit confirmation. Two modes over one sheet:
 *
 * - `end` — terminates the session for every member and produces the summary.
 * - `leave` — this device drops out; everyone else keeps climbing.
 *
 * Before #3502 only `end` existed, and it was the ONLY exit on mobile — so a
 * climber who joined their own party from a second phone had to kill it for
 * everyone (the HTTP endSession branch authorizes on creator user id, which
 * their second phone passes) just to get out. Both actions are now always
 * reachable when they're legal; `defaultMode` only decides which one leads.
 */
export function EndSessionSheet({
  visible,
  onDismiss,
  onConfirm,
  onLeave,
  isEnding,
  isLeaving,
  climbCount,
  notes,
  onNotesChange,
  defaultMode,
  canEnd,
}: EndSessionSheetProps) {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();

  // Resolved mode. A known non-creator can never reach `end`, whatever mode
  // was selected — that request would be refused server-side anyway.
  const [mode, setMode] = useState<SessionExitMode>(defaultMode);
  const effectiveMode = canEnd ? mode : 'leave';
  // Re-arm on OPEN only, so a climber who switched modes last time doesn't
  // inherit that choice on the next exit. Deliberately keyed on the open
  // transition rather than on `defaultMode` itself: device provenance resolves
  // asynchronously, and a late resolve must not yank the sheet out from under
  // someone who has already tapped through to the other mode.
  const wasVisibleRef = useRef(false);
  const latestDefaultModeRef = useRef(defaultMode);
  latestDefaultModeRef.current = defaultMode;
  useEffect(() => {
    if (visible && !wasVisibleRef.current) setMode(latestDefaultModeRef.current);
    wasVisibleRef.current = visible;
  }, [visible]);

  const isEndMode = effectiveMode === 'end';
  const busy = isEnding || isLeaving;

  // The bar's actions have no disabled state of their own, so they go inert
  // while either exit is in flight, as the old buttons did.
  const handleKeepClimbing = useCallback(() => {
    if (!busy) onDismiss();
  }, [busy, onDismiss]);

  return (
    <ModalSheet
      visible={visible}
      onClose={onDismiss}
      enablePanDownToClose={!busy}
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      androidContentSized
      scrollable
      header={
        <SheetTopBar
          title={isEndMode ? t('mobile.queue.endSession') : t('mobile.queue.leaveSession')}
          // Leaving loses nothing: the recap stays with the parent.
          leading={{
            kind: 'close',
            onPress: handleKeepClimbing,
            accessibilityLabel: t('mobile.queue.endSessionCancel'),
          }}
          trailing={
            isEndMode
              ? {
                  // A destructive commit: red text, never a red ✓.
                  kind: 'confirm',
                  label: t('mobile.queue.endSession'),
                  onPress: onConfirm,
                  loading: isEnding,
                  disabled: isLeaving,
                  prominent: true,
                  destructive: true,
                }
              : {
                  // Leaving commits nothing of the climber's: text, not the ✓.
                  kind: 'forward',
                  label: t('mobile.queue.leaveSessionAction'),
                  onPress: onLeave,
                  loading: isLeaving,
                  disabled: isEnding,
                  prominent: true,
                }
          }
        />
      }
    >
      <View testID="end-session-content" style={styles.content}>
        <Icon name={isEndMode ? 'end.session' : 'leave.session'} size={40} color={systemColors.secondaryLabel} />

        <Text variant="body" color={systemColors.secondaryLabel} style={styles.subtitle}>
          {isEndMode ? t('mobile.queue.endSessionConfirm') : t('mobile.queue.leaveSessionConfirm')}
        </Text>

        <View style={styles.statRow}>
          <Icon name="tick.outline" size={16} color={systemColors.secondaryLabel} />
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {t('mobile.queue.climbCount', { count: climbCount })}
          </Text>
        </View>

        {/* Optional Strava-style recap. Typing never gates End — an empty field
              behaves exactly as before. Leaving produces no summary, so the recap
              has nowhere to land and is hidden in that mode. */}
        {isEndMode ? (
          <BottomSheetTextInput
            style={[styles.notesInput, { backgroundColor: systemColors.fill, color: systemColors.label }]}
            placeholder={t('mobile.queue.endSessionCommentPlaceholder')}
            placeholderTextColor={systemColors.tertiaryLabel}
            accessibilityLabel={t('mobile.queue.endSessionCommentAria')}
            value={notes}
            onChangeText={onNotesChange}
            maxLength={SESSION_NOTES_MAX_LENGTH}
            multiline
          />
        ) : null}

        {/* The other exit, always one tap away when it's legal. Low emphasis:
              a row in the body, not a second confirm in the bar. */}
        {isEndMode ? (
          <Button
            title={t('mobile.queue.leaveInsteadAction')}
            variant="text"
            size="small"
            onPress={() => setMode('leave')}
            disabled={busy}
          />
        ) : canEnd ? (
          <Button
            title={t('mobile.queue.endForEveryone')}
            variant="text"
            size="small"
            role="destructive"
            tintColor={brandColors.error}
            onPress={() => setMode('end')}
            disabled={busy}
          />
        ) : null}
      </View>
    </ModalSheet>
  );
}

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    content: {
      paddingHorizontal: spacing[6],
      paddingTop: spacing[4],
      paddingBottom: spacing[3],
      alignItems: 'center',
      gap: spacing[3],
    },
    subtitle: {
      textAlign: 'center',
      lineHeight: 20,
    },
    statRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[2],
    },
    notesInput: {
      width: '100%',
      minHeight: 64,
      maxHeight: 120,
      borderRadius: borderRadius.lg,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[2],
      fontSize: textStyles.subheadline.fontSize,
      // Multiline text should start at the top on Android (matches iOS default).
      textAlignVertical: 'top',
    },
  });
