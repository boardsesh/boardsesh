import { useEffect, useRef, useState } from 'react';
import { View, KeyboardAvoidingView, StyleSheet } from 'react-native';
import BottomSheet, {
  BottomSheetView,
  BottomSheetTextInput,
  type BottomSheetMethods,
} from '@expo/ui/community/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { SESSION_NOTES_MAX_LENGTH } from '@boardsesh/shared-schema';
import { Text } from './Text';
import { Button } from './Button';
import { Icon } from './Icon';
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
  const insets = useSafeAreaInsets();
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
      <BottomSheetView style={[styles.content, { paddingBottom: insets.bottom + spacing[3] }]}>
        {/* The Compose/UIKit sheet window does not resize for the keyboard, so a
            JS-side KeyboardAvoidingView lifts the recap input + buttons above it
            on both platforms (mirrors Sheet.tsx). BottomSheetView stays the
            sheet's single child. */}
        <KeyboardAvoidingView behavior="padding" style={styles.avoider}>
          <Icon name={isEndMode ? 'end.session' : 'leave.session'} size={40} color={systemColors.secondaryLabel} />

          <Text variant="title2" style={styles.title}>
            {isEndMode ? t('mobile.queue.endSession') : t('mobile.queue.leaveSession')}
          </Text>

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

          <View style={styles.buttonRow}>
            <Button
              title={t('mobile.queue.endSessionCancel')}
              variant="outlined"
              onPress={onDismiss}
              disabled={busy}
              style={styles.button}
            />
            {isEndMode ? (
              <Button
                title={t('mobile.queue.endSession')}
                onPress={onConfirm}
                loading={isEnding}
                role="destructive"
                style={styles.button}
              />
            ) : (
              <Button
                title={t('mobile.queue.leaveSessionAction')}
                onPress={onLeave}
                loading={isLeaving}
                style={styles.button}
              />
            )}
          </View>

          {/* The other exit, always one tap away when it's legal. Low emphasis:
              this is the deliberate second step, not a second primary CTA. */}
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
        </KeyboardAvoidingView>
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    // No flex:1 — enableDynamicSizing measures the content's intrinsic height.
    paddingHorizontal: spacing[6],
    paddingTop: spacing[4],
  },
  avoider: {
    alignItems: 'center',
    gap: spacing[3],
  },
  title: {
    fontWeight: '600',
    textAlign: 'center',
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
  buttonRow: {
    flexDirection: 'row',
    gap: spacing[3],
    marginTop: spacing[4],
    width: '100%',
  },
  button: {
    flex: 1,
  },
});
