import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SprayWallReportReason } from '@boardsesh/graphql/operations/spray-walls';
import type { RadioOption } from '../RadioGroup';
import { ReportProblemSheet } from '../report-problem/ReportProblemSheet';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';
import { useReportSprayWall, useSprayModerationAccess } from '../../lib/spray/use-spray-moderation';

const REASONS: SprayWallReportReason[] = ['INAPPROPRIATE', 'NOT_A_WALL', 'PERSONAL_INFO', 'OTHER'];

/**
 * Report a Spraywall to the spray admins. A Spraywall keeps its own reasons
 * (a photo can be inappropriate or carry personal details, which a catalogue
 * board can't) and its own review queue, on the shared report sheet.
 */
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
  const { canReport } = useSprayModerationAccess();
  const { effectiveOffline } = useConnectivity();
  const report = useReportSprayWall();
  const inFlight = useRef(false);
  const [reason, setReason] = useState<SprayWallReportReason | null>(null);
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

  return (
    <ReportProblemSheet
      title={t('sprayModeration.reportTitle')}
      subject={wallName}
      reasons={reasonOptions}
      reason={reason}
      onReasonChange={pickReason}
      sendLabel={t('sprayModeration.submit')}
      canSend={!!reason && !effectiveOffline}
      pending={report.isPending}
      onSend={submit}
      doneMessage={report.isSuccess ? t('sprayModeration.reported') : null}
      unavailableMessage={canReport ? null : t('sprayModeration.unavailable')}
      offlineMessage={effectiveOffline ? t('sprayModeration.reportOffline') : null}
      errorMessage={report.isError ? t('sprayModeration.reportError') : null}
      dirty={reason !== null}
      onClose={onClose}
    />
  );
}
