import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SprayWallReportReason } from '@boardsesh/graphql/operations/spray-walls';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
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
  const { systemColors, chartColors } = useTheme();
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
  return (
    <ModalSheet
      visible
      snapPoints={['65%', '90%']}
      androidContentSized
      scrollable
      onClose={onClose}
      contentContainerStyle={styles.body}
      footer={
        report.isSuccess || !canReport ? (
          <Button title={tCommon('actions.done')} onPress={onClose} />
        ) : (
          <Button
            title={t('sprayModeration.submit')}
            onPress={submit}
            variant={submitDisabled ? 'tonal' : 'filled'}
            // SwiftUI needs the plain-string palette instead of PlatformColor.
            tintColor={submitDisabled ? chartColors.label : undefined}
            over="surface"
            disabled={submitDisabled}
            loading={report.isPending}
          />
        )
      }
    >
      <Text variant="title2">{t('sprayModeration.reportTitle')}</Text>
      <Text variant="body" color={systemColors.secondaryLabel}>
        {wallName}
      </Text>
      {!canReport ? (
        <Text>{t('sprayModeration.unavailable')}</Text>
      ) : report.isSuccess ? (
        <Text accessibilityLiveRegion="polite">{t('sprayModeration.reported')}</Text>
      ) : (
        <>
          {REASONS.map((option) => (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityState={{ checked: option === reason, disabled: report.isPending }}
              accessibilityLabel={labels[option]}
              disabled={report.isPending}
              onPress={() => setReason(option)}
              style={styles.reason}
            >
              <Icon name={option === reason ? 'check.small' : 'circle'} size={20} color={systemColors.label} />
              <Text style={styles.label}>{labels[option]}</Text>
            </Pressable>
          ))}
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
  reason: { flexDirection: 'row', alignItems: 'center', minHeight: 48, gap: spacing[3] },
  label: { flex: 1 },
});
