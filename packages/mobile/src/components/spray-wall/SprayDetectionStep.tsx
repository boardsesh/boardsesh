import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SprayDetectionCandidate } from '@boardsesh/shared-schema';
import { sprayWallDetectionFinished } from '@boardsesh/analytics';
import { useSprayDetection } from '../../lib/spray/use-spray-detection';
import { trackSprayEvent } from '../../lib/spray/spray-telemetry';
import { Text } from '../Text';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { SprayScanPhoto } from './SprayScanPhoto';

/** How long a scan runs before the card admits it is taking a while. */
const SLOW_SCAN_MS = 8000;

export function SprayDetectionStep({
  wallUuid,
  versionId,
  photo,
  onComplete,
  onManual,
}: {
  wallUuid: string;
  versionId: string;
  /**
   * The photo on this phone, when there is one. With it the step is the
   * full-screen scan (`SprayScanPhoto`); without it (the reset flow, or a run
   * resumed on a phone that never had the file) it stays the plain spinner.
   */
  photo?: { uri: string; width: number; height: number } | null;
  onComplete: (candidates: SprayDetectionCandidate[]) => void;
  onManual?: () => void;
}) {
  const { t } = useTranslation('boards');
  const { query, retry, offline } = useSprayDetection(wallUuid, versionId);
  const delivered = useRef<string | null>(null);
  const detection = query.data;
  useEffect(() => {
    if (detection?.status !== 'done' || !detection.result || delivered.current === detection.id) return;
    delivered.current = detection.id;
    trackSprayEvent(
      sprayWallDetectionFinished({
        outcome: 'ok',
        candidateCount: detection.result.candidates.length,
        durationMs: Date.parse(detection.finishedAt ?? detection.createdAt) - Date.parse(detection.createdAt),
      }),
    );
    onComplete(detection.result.candidates);
  }, [detection, onComplete]);

  const failed = detection?.status === 'failed' || detection?.status === 'cancelled';
  const unreachable = offline || query.isError || retry.isError;
  const running = detection?.status === 'running';
  // The full-screen scan is the add-a-wall flow's alone, with its own short
  // lines. The spinner below is also the reset flow's, and keeps the wording
  // that says what is being waited on.
  const message = unreachable
    ? t('sprayDetection.connection')
    : failed
      ? t('sprayDetection.failed')
      : !running && detection?.retryAt
        ? t('sprayDetection.retrying')
        : !running && detection?.queuePosition != null
          ? t('sprayDetection.queuePosition', { position: detection.queuePosition })
          : photo
            ? running
              ? t('sprayWizard.scan.running')
              : t('sprayWizard.scan.queued')
            : running
              ? t('sprayDetection.running')
              : t('sprayDetection.queued');

  // Restarted by every retry, so a second attempt gets its own eight seconds.
  const [slowEpoch, setSlowEpoch] = useState(0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), SLOW_SCAN_MS);
    return () => clearTimeout(timer);
  }, [slowEpoch]);

  const retryMutate = retry.mutate;
  const handleRetry = useCallback(() => {
    setSlowEpoch((epoch) => epoch + 1);
    retryMutate();
  }, [retryMutate]);

  if (photo) {
    const stopped = failed || unreachable;
    return (
      <SprayScanPhoto
        photo={photo}
        message={message}
        detail={slow && !stopped ? t('sprayWizard.scan.slow') : null}
        resumeHint={`${t('sprayWizard.scan.resumeHint')} ${t('sprayDetection.notifyHint')}`}
        failed={stopped}
        retry={{ label: t('sprayDetection.retry'), onPress: handleRetry, disabled: retry.isPending }}
        manual={onManual ? { label: t('sprayDetection.manual'), onPress: onManual } : undefined}
      />
    );
  }

  return (
    <>
      <Text variant="title3">{t('sprayWizard.detect.title')}</Text>
      {!failed && !query.isError ? <ActivityIndicator /> : null}
      <Text>{message}</Text>
      <Text>{t('sprayDetection.resumeHint')}</Text>
      <Text>{t('sprayDetection.notifyHint')}</Text>
      {failed || unreachable ? (
        <Button title={t('sprayDetection.retry')} disabled={retry.isPending} onPress={handleRetry} />
      ) : null}
      {onManual ? <Button title={t('sprayDetection.manual')} variant="text" onPress={onManual} /> : null}
    </>
  );
}
