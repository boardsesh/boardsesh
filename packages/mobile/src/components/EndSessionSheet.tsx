import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Platform, StyleSheet } from 'react-native';
import BottomSheet, {
  BottomSheetView,
  BottomSheetTextInput,
  type BottomSheetMethods,
} from '@expo/ui/community/bottom-sheet';
import { useWindowBottomInset } from '../hooks/use-window-bottom-inset';
import { useKeyboardHeight } from '../hooks/use-keyboard-height';
import { useTranslation } from 'react-i18next';
import { SESSION_NOTES_MAX_LENGTH } from '@boardsesh/shared-schema';
import { Text } from './Text';
import { Button } from './Button';
import { Icon } from './Icon';
import { SheetTopBar } from './SheetTopBar';
import { useTheme } from '../providers/theme-provider';
import { useManagedSheet } from '../providers/sheet-presentation-provider';
import { spacing, borderRadius, sheetStyles } from '../theme/tokens';
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
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const windowInsetBottom = useWindowBottomInset();
  const keyboardHeight = useKeyboardHeight();
  const bottomClearance =
    Platform.OS === 'android' ? keyboardHeight + windowInsetBottom : Math.max(windowInsetBottom, keyboardHeight);
  const sheetRef = useRef<BottomSheetMethods>(null);

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

  // Present/dismiss route through the coordinator (serialized, no overlapping
  // native transitions). Always mounted by InSessionView and toggled via
  // `visible`, so no onFullyDismissed; `onDismiss` clears the parent's open state
  // on a user pan-down / backdrop.
  const managed = useManagedSheet({ open: visible, sheetRef, onClose: onDismiss });

  // The bar's actions have no disabled state of their own, so they go inert
  // while either exit is in flight, as the old buttons did.
  const handleKeepClimbing = useCallback(() => {
    if (!busy) onDismiss();
  }, [busy, onDismiss]);

  return (
    <BottomSheet
      ref={sheetRef}
      index={-1}
      // Size to content rather than a fixed snap point — with safe-area bottom
      // padding added (up to ~34pt on gesture-nav phones), a fixed '35%' could
      // crowd or clip the buttons on shorter devices.
      enableDynamicSizing
      enablePanDownToClose
      onChange={managed.onChange}
      onFullyDismissed={managed.onFullyDismissed}
      backgroundStyle={{ backgroundColor: systemColors.secondaryBackground }}
      handleIndicatorStyle={sheetStyles.indicator}
    >
      {/* The sheet's single child: the top bar and the body share it. */}
      <BottomSheetView>
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
        {/* The Compose/UIKit sheet window does not resize for the keyboard, so the
            content pads itself above it on both platforms. The sheet sizes to its
            content and its bottom edge is the window's, so the keyboard height is
            exactly the overlap. On iOS the keyboard height includes the home
            indicator, so the pad is the larger of the two, never their sum. On
            Android RN reports the IME inset minus the system bars, and this
            edge-to-edge sheet sits over the navigation bar, so the overlap is
            keyboard + inset. Not a KeyboardAvoidingView: RN
            0.86 measures overlap from its parent-relative onLayout frame, which
            inside this sheet finds none. */}
        <View testID="end-session-content" style={[styles.content, { paddingBottom: bottomClearance + spacing[3] }]}>
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
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    // No flex:1 — enableDynamicSizing measures the content's intrinsic height.
    paddingHorizontal: spacing[6],
    paddingTop: spacing[4],
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
    fontSize: 15,
    // Multiline text should start at the top on Android (matches iOS default).
    textAlignVertical: 'top',
  },
});
