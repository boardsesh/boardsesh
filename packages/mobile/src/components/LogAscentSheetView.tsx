import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, View, type LayoutChangeEvent, type ViewInstance } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getGradeColor } from '@boardsesh/board-constants/grade-colors';
import type { TickStatus } from '@boardsesh/play-view';
import { PublicationAudiencePicker } from './privacy/PublicationAudiencePicker';
import { ModalSheet } from './ModalSheet';
import { SheetPresentationContent } from './sheet-presentation-context';
import { useCreateTickSnapPoints } from './use-create-tick-snap-points';
import { TickActionBar, TickNoteField, TickSheetHeader, CREATE_TICK_SNAP_POINTS, useSwipeUpToOpen } from './tick';
import type { ManagedSheetHandle, PresenterGroup } from '../providers/sheet-presentation-provider';
import type { QuickTickForm } from './play-drawer/use-quick-tick-form';
import type { QuickTickBarProps } from './play-drawer/QuickTickBar';
const SAVE_ICON = 'tick.outline' as const;
export type LogAscentSheetViewProps = {
  presenterGroup?: PresenterGroup;
  parentSheetId?: string;
  stacked?: boolean;
  visible: boolean;
  onClose: () => void;
  onFullyDismissed?: () => void;
  onPresented?: () => void;
  climbName?: string;
  angle: number;
  consensusGradeName?: string;
  baseAscensionistCount: number;
  form: QuickTickForm;
  renderFields: (options: Omit<QuickTickBarProps, 'form'>) => ReactNode;
};
export function LogAscentSheetView({
  presenterGroup,
  parentSheetId,
  stacked,
  visible,
  onClose,
  onFullyDismissed,
  onPresented,
  climbName,
  angle,
  consensusGradeName,
  baseAscensionistCount,
  form,
  renderFields,
}: LogAscentSheetViewProps) {
  const { t, i18n } = useTranslation('climbs');
  const sheetRef = useRef<ManagedSheetHandle>(null);
  const [expanded, setExpanded] = useState(false);
  const compactNote = Platform.OS !== 'android' && !expanded;
  // Android has one content-fitted state and no detent to reveal Angle and Date
  // with (#7343), so a row folds them away and a swipe up opens them, the nearest
  // thing to dragging the iOS sheet up. Separate from `expanded`:
  // Android fires onChange(0) on open, and handleDetentChange would close
  // anything sharing that state.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const foldsDetails = Platform.OS === 'android';
  const showDetails = foldsDetails ? detailsOpen : !compactNote;
  const openDetails = useCallback(() => setDetailsOpen(true), []);
  const detailsDisclosure = useMemo(
    () => (foldsDetails ? { open: detailsOpen, onOpen: openDetails } : undefined),
    [foldsDetails, detailsOpen, openDetails],
  );
  const swipeUpHandlers = useSwipeUpToOpen(foldsDetails && !detailsOpen, openDetails);
  const { snapPoints, onHeaderLayout, onFooterLayout, onBodyLayout } = useCreateTickSnapPoints(
    i18n?.resolvedLanguage,
    compactNote,
  );

  const formFieldsRef = useRef<ViewInstance>(null);
  // Include every field, including the audience picker, rather than just the
  // first two rows. Re-measure unchanged intrinsic geometry after cache resets
  // without remounting controls or the pinned note.
  useEffect(() => {
    formFieldsRef.current?.measure((_left, _top, _measuredWidth, height) => onBodyLayout(height));
  }, [onBodyLayout]);
  const handleFormFieldsLayout = useCallback(
    (event: LayoutChangeEvent) => onBodyLayout(event.nativeEvent.layout.height),
    [onBodyLayout],
  );

  const handleDetentChange = useCallback((index: number) => {
    if (index >= 0) setExpanded(index > 0);
  }, []);
  const handleNoteFocus = useCallback(() => {
    if (Platform.OS !== 'android' && !expanded) sheetRef.current?.snapToIndex(CREATE_TICK_SNAP_POINTS.length - 1);
  }, [expanded]);

  useEffect(() => {
    if (visible) {
      setExpanded(false);
      setDetailsOpen(false);
    }
  }, [visible]);
  // The identity bar follows the picked grade the moment the climber picks one,
  // and falls back to the community consensus before that.
  const gradeColor = useMemo(
    () => getGradeColor(form.resolvedGradeName ?? consensusGradeName ?? ''),
    [form.resolvedGradeName, consensusGradeName],
  );

  // `logAscentAria` interpolates a *noun*, so the status has to be resolved to
  // localised copy first — interpolating the raw `'send'` / `'flash'` enum left
  // Spanish, French and German screen-reader users hearing English.
  // Spelled out per key because the i18n linter rejects `t(variable)`.
  const statusNouns: Record<TickStatus, string> = useMemo(
    () => ({
      flash: t('mobile.tick.status.flash'),
      send: t('mobile.tick.status.send'),
      attempt: t('mobile.tick.status.attempt'),
    }),
    [t],
  );

  // "Consensus" only once somebody has sent it (#5960 C7): before that, the
  // grade a climb carries is its setter's, not a crowd's. And only at the angle
  // the sheet opened at: the consensus and the send count are that angle's, so
  // once the climber picks another one the subtitle names just the angle.
  const subtitle =
    consensusGradeName && baseAscensionistCount > 0 && form.angle === angle
      ? t('mobile.tick.consensusMeta', { grade: consensusGradeName, angle: form.angle })
      : t('mobile.tick.angleMeta', { angle: form.angle });

  return (
    <ModalSheet
      presenterGroup={presenterGroup}
      parentSheetId={parentSheetId}
      stacked={stacked}
      ref={sheetRef}
      visible={visible}
      accessibilityLabel={climbName ?? t('mobile.tick.fallbackTitle')}
      onRequestClose={onClose}
      onClose={onClose}
      onFullyDismissed={onFullyDismissed}
      onPresented={onPresented}
      snapPoints={snapPoints}
      onHeaderLayout={onHeaderLayout}
      onFooterLayout={onFooterLayout}
      onChange={handleDetentChange}
      scrollable
      footerSurface="flush"
      // Android's ~50% partial state can't fit this form under a pinned footer
      // (#4723), and a near-full single detent leaves ~310 dp of void below it
      // (#4720). Size the sheet to the form on Android instead — see
      // `androidContentSized` on `ModalSheet`.
      androidContentSized
      header={
        // The header is what a climber grabs to pull a sheet up, so it swipes too.
        // `collapsable={false}`: a flattened view would not receive the touches.
        <View collapsable={false} testID="tick-sheet-swipe-header" {...swipeUpHandlers}>
          <TickSheetHeader
            title={climbName ?? t('mobile.tick.fallbackTitle')}
            subtitle={subtitle}
            gradeColor={gradeColor}
            onClose={onClose}
            closeAccessibilityLabel={t('mobile.tick.closeAria')}
          />
        </View>
      }
      footer={
        <SheetPresentationContent>
          {({ supportsDetents }) => (
            <TickActionBar
              note={
                <TickNoteField
                  value={form.comment}
                  onChangeText={form.onCommentChange}
                  placeholder={t('mobile.tick.notePlaceholder')}
                  accessibilityLabel={t('mobile.tick.noteAria')}
                  compact={supportsDetents && compactNote}
                  onFocus={supportsDetents ? handleNoteFocus : undefined}
                />
              }
              error={form.lastError}
              secondary={{
                title: t('mobile.tick.attempt'),
                onPress: form.onAttempt,
                disabled: form.isPending,
                accessibilityLabel: t('mobile.tick.logAscentAria', { status: statusNouns.attempt }),
              }}
              primary={{
                title: form.saveLabel,
                onPress: form.onSave,
                loading: form.isPending,
                disabled: form.saveBlockedByGrade,
                icon: SAVE_ICON,
                accessibilityLabel: t('mobile.tick.logAscentAria', { status: statusNouns[form.ascentType] }),
              }}
            />
          )}
        </SheetPresentationContent>
      }
    >
      <View
        ref={formFieldsRef}
        onLayout={handleFormFieldsLayout}
        testID="tick-form-fields"
        collapsable={false}
        {...swipeUpHandlers}
      >
        <SheetPresentationContent>
          {({ supportsDetents }) =>
            renderFields({
              showNote: false,
              showDate: !supportsDetents || showDetails,
              showAngle: !supportsDetents || showDetails,
              detailsDisclosure: supportsDetents ? detailsDisclosure : undefined,
            })
          }
        </SheetPresentationContent>
        <PublicationAudiencePicker privacy={form.privacy} disabled={form.isPending} />
      </View>
    </ModalSheet>
  );
}
