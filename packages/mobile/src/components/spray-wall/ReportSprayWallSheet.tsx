import { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SprayWallReportReason } from '@boardsesh/graphql/operations/spray-walls';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { RadioGroup, type RadioOption } from '../RadioGroup';
import { SheetTopBar } from '../SheetTopBar';
import { useTheme } from '../../providers/theme-provider';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';
import { useReportSprayWall, useSprayModerationAccess } from '../../lib/spray/use-spray-moderation';
import { spacing } from '../../theme/tokens';

const REASONS: SprayWallReportReason[] = ['INAPPROPRIATE', 'NOT_A_WALL', 'PERSONAL_INFO', 'OTHER'];

export function ReportSprayWallSheet({
  wallUuid,
  wallName,
  onClose,
}: {
  wallUuid: string;
  wallName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('boards');
  const { t: tCommon } = useTranslation('common');
  const { systemColors } = useTheme();
  const { canReport } = useSprayModerationAccess();
  const { effectiveOffline } = useConnectivity();
  const report = useReportSprayWall();
  const inFlight = useRef(false);
  const [reason, setReason] = useState<SprayWallReportReason | null>(null);
  const submitDisabled = !reason || effectiveOffline || report.isPending;
  const labels: Record<SprayWallReportReason, string> = {
    INAPPROPRIATE: t('sprayModeration.reasons.inappropriate'),
    NOT_A_WALL: t('sprayModeration.reasons.notAWall'),
    PERSONAL_INFO: t('sprayModeration.reasons.personalInfo'),
    OTHER: t('sprayModeration.reasons.other'),
  };
  const reasonOptions: RadioOption<SprayWallReportReason>[] = REASONS.map((option) => ({
    value: option,
    label: labels[option],
    disabled: report.isPending,
  }));
  const pickReason = useCallback(
    (next: SprayWallReportReason) => {
      if (!report.isPending) setReason(next);
    },
    [report.isPending],
  );
  const submit = useCallback(() => {
    if (!reason || !canReport || effectiveOffline || inFlight.current || report.isSuccess) return;
    inFlight.current = true;
    report.mutate(
      { input: { wallUuid, reason } },
      {
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  }, [reason, canReport, effectiveOffline, report, wallUuid]);
  const finished = report.isSuccess || !canReport;
  const header = (
    <SheetTopBar
      title={t('sprayModeration.reportTitle')}
      leading={finished ? undefined : { kind: 'cancel', onPress: onClose }}
      trailing={
        finished
          ? { label: tCommon('actions.done'), onPress: onClose, prominent: true }
          : {
              label: t('sprayModeration.submit'),
              onPress: submit,
              disabled: submitDisabled,
              loading: report.isPending,
              prominent: true,
            }
      }
    />
  );
  return (
    <ModalSheet
      visible
      snapPoints={['65%', '90%']}
      androidContentSized
      scrollable
      onClose={onClose}
      contentContainerStyle={styles.body}
      header={header}
    >
      <Text variant="body" color={systemColors.secondaryLabel}>
        {wallName}
      </Text>
      {!canReport ? (
        <Text>{t('sprayModeration.unavailable')}</Text>
      ) : report.isSuccess ? (
        <Text accessibilityLiveRegion="polite">{t('sprayModeration.reported')}</Text>
      ) : (
        <>
          {/* The app's native RadioGroup (SwiftUI inline Picker / Compose RadioButtons)
              instead of a hand-drawn list: brand-tinted checkmark, platform picker a11y. */}
          {/* Locked while the report is in flight. The iOS inline Picker ignores a
              per-option `disabled`, so the whole group stops taking touches and
              the handler refuses a change too. */}
          <View
            pointerEvents={report.isPending ? 'none' : 'auto'}
            accessibilityState={{ disabled: report.isPending }}
            style={report.isPending ? styles.locked : undefined}
          >
            <RadioGroup options={reasonOptions} value={reason} onChange={pickReason} />
          </View>
          {effectiveOffline ? (
            <Text color={systemColors.secondaryLabel}>{t('sprayModeration.reportOffline')}</Text>
          ) : null}
          {report.isError ? <Text accessibilityLiveRegion="polite">{t('sprayModeration.reportError')}</Text> : null}
        </>
      )}
    </ModalSheet>
  );
}
const styles = StyleSheet.create({
  body: { padding: spacing[4], gap: spacing[3] },
  locked: { opacity: 0.5 },
});
