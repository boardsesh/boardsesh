// "Report a problem": one sheet for every kind of report about a place or a
// wall. The board and gym reports (ReportDirectorySheet) and the Spraywall
// report (ReportSprayWallSheet) each own their reasons, their mutation and
// their copy, and hand this sheet the result. It owns the chrome: the top bar
// (Cancel / title / ✓ Send, then Done), the native reason picker, the unsaved
// guard, and the offline, error and done lines.
//
// Controlled on purpose: the sheet holds no report state, so a caller can lock
// the reasons while a send is in flight and swap the body for its done line
// without the sheet knowing which mutation ran.

import type { ReactNode, Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { useUnsavedSheetGuard } from '../../hooks/use-unsaved-sheet-guard';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { RadioGroup, type RadioOption } from '../RadioGroup';
import { SheetTopBar } from '../SheetTopBar';
import { useTheme } from '../../providers/theme-provider';
import type { ManagedSheetHandle } from '../../providers/sheet-presentation-provider';
import { spacing } from '../../theme/tokens';

export type ReportProblemSheetProps<R extends string> = {
  title: string;
  /** The thing being reported, in secondary text under the top bar ("Crux Kilter at Crux"). */
  subject?: string | null;
  /** A heading above the reasons ("What's wrong?"). */
  question?: string | null;
  /** The reasons, already labelled. Locked while `pending`. */
  reasons: readonly RadioOption<R>[];
  reason: R | null;
  onReasonChange: (reason: R) => void;
  /** Under the reasons, for the chosen reason: an inline picker, a note. */
  detail?: ReactNode;
  /** The foot of the form: who will see it, and anything offered beside that. */
  footer?: ReactNode;
  /** Spoken label of the ✓ (Send). */
  sendLabel: string;
  /** Send is enabled: a reason, a valid note, online, nothing in flight. */
  canSend: boolean;
  pending: boolean;
  onSend: () => void;
  /** The report went through: the body becomes this line and the trailing action Done. */
  doneMessage?: string | null;
  /** A heading above the done line ("Setup updated"). */
  doneTitle?: string | null;
  /**
   * What the climber can do next, under the done line ("Climb it now"). When it
   * is there it is the primary action, so the top bar's Done steps back.
   */
  doneAction?: ReactNode;
  /** The sheet can't take a report at all; shown in place of the form, with Done. */
  unavailableMessage?: string | null;
  /** Shown under the form while the phone is offline. */
  offlineMessage?: string | null;
  /** Shown under the form after a failed send. */
  errorMessage?: string | null;
  /** Something the climber entered would be lost by a swipe down. */
  dirty: boolean;
  onClose: () => void;
  /**
   * The managed sheet, for a caller that must wait for it to finish sliding
   * away before the next surface presents (`dismissManagedSheetAndWait`).
   */
  sheetRef?: Ref<ManagedSheetHandle>;
  testID?: string;
};

export function ReportProblemSheet<R extends string>({
  title,
  subject,
  question,
  reasons,
  reason,
  onReasonChange,
  detail,
  footer,
  sendLabel,
  canSend,
  pending,
  onSend,
  doneMessage,
  doneTitle,
  doneAction,
  unavailableMessage,
  offlineMessage,
  errorMessage,
  dirty,
  onClose,
  sheetRef,
  testID,
}: ReportProblemSheetProps<R>) {
  const { t: tCommon } = useTranslation('common');
  const { systemColors } = useTheme();
  const finished = !!doneMessage || !!unavailableMessage;
  const guard = useUnsavedSheetGuard({
    visible: true,
    dirty: dirty && !finished,
    busy: pending,
    onClose,
  });

  const header = (
    <SheetTopBar
      title={title}
      leading={finished ? undefined : { kind: 'cancel', onPress: guard.requestClose }}
      trailing={
        finished
          ? { kind: 'forward', label: tCommon('actions.done'), onPress: onClose, prominent: !doneAction }
          : {
              // A report goes to someone else, but a compact sheet header sends it
              // with the ✓ (mobile-chrome.md, "Feedback and report submits").
              kind: 'confirm',
              label: sendLabel,
              onPress: onSend,
              disabled: !canSend || pending,
              loading: pending,
              prominent: true,
            }
      }
    />
  );

  return (
    <ModalSheet
      ref={sheetRef}
      visible
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      androidContentSized
      scrollable
      onDisplaced={onClose}
      onClose={guard.requestClose}
      onRequestClose={guard.requestClose}
      enablePanDownToClose={guard.enablePanDownToClose}
      contentContainerStyle={styles.body}
      header={header}
    >
      {subject ? (
        <Text variant="body" color={systemColors.secondaryLabel} testID={testID ? `${testID}-subject` : undefined}>
          {subject}
        </Text>
      ) : null}
      {unavailableMessage ? (
        <Text>{unavailableMessage}</Text>
      ) : doneMessage ? (
        <>
          {doneTitle ? (
            <Text variant="headline" accessibilityRole="header" testID={testID ? `${testID}-done-title` : undefined}>
              {doneTitle}
            </Text>
          ) : null}
          <Text accessibilityLiveRegion="polite" testID={testID ? `${testID}-done` : undefined}>
            {doneMessage}
          </Text>
          {doneAction}
        </>
      ) : (
        <>
          {question ? (
            <Text variant="headline" accessibilityRole="header">
              {question}
            </Text>
          ) : null}
          {/* The app's native RadioGroup (SwiftUI inline Picker / Compose RadioButtons)
              instead of a hand-drawn list: brand-tinted checkmark, platform picker a11y.
              Locked while the report is in flight. The iOS inline Picker ignores a
              per-option `disabled`, so the whole group stops taking touches and the
              caller refuses a change too. */}
          <View
            pointerEvents={pending ? 'none' : 'auto'}
            accessibilityState={{ disabled: pending }}
            style={pending ? styles.locked : undefined}
          >
            <RadioGroup options={reasons} value={reason} onChange={onReasonChange} />
          </View>
          {detail}
          {footer}
          {offlineMessage ? <Text color={systemColors.secondaryLabel}>{offlineMessage}</Text> : null}
          {errorMessage ? <Text accessibilityLiveRegion="polite">{errorMessage}</Text> : null}
        </>
      )}
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing[4], gap: spacing[3] },
  locked: { opacity: 0.5 },
});
