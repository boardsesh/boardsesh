import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { SprayDetectionCandidate } from '@boardsesh/shared-schema';
import { sprayWallDetectionFinished } from '@boardsesh/analytics';
import { useSprayDetection } from '../../lib/spray/use-spray-detection';
import { trackSprayEvent } from '../../lib/spray/spray-telemetry';
import { Text } from '../Text';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';

export function SprayDetectionStep({
  wallUuid,
  versionId,
  onComplete,
  onManual,
}: {
  wallUuid: string;
  versionId: string;
  onComplete: (candidates: SprayDetectionCandidate[]) => void;
  onManual?: () => void;
}) {
  const { t } = useTranslation('boards');
  const { query, retry } = useSprayDetection(wallUuid, versionId);
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
  return (
    <>
      <Text variant="title3">{t('sprayWizard.detect.title')}</Text>
      {!failed && !query.isError ? <ActivityIndicator /> : null}
      <Text>
        {query.isError || retry.isError
          ? t('sprayDetection.connection')
          : failed
            ? t('sprayDetection.failed')
            : detection?.status === 'running'
              ? t('sprayDetection.running')
              : t('sprayDetection.queued')}
      </Text>
      <Text>{t('sprayDetection.resumeHint')}</Text>
      {failed || query.isError || retry.isError ? (
        <Button title={t('sprayDetection.retry')} disabled={retry.isPending} onPress={() => retry.mutate()} />
      ) : null}
      {onManual ? <Button title={t('sprayDetection.manual')} variant="text" onPress={onManual} /> : null}
    </>
  );
}
