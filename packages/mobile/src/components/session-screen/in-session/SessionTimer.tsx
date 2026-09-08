import { useEffect, useState } from 'react';
import { Text } from '../../Text';
import { nowMs } from '../../../lib/clock';

type SessionTimerProps = {
  startedAt: string | null | undefined;
  color?: string;
};

function format(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = minutes.toString().padStart(2, '0');
  const ss = seconds.toString().padStart(2, '0');
  if (hours > 0) return `${hours}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

/**
 * mm:ss timer driven by setInterval(1s). Pure UI; reads startedAt from the
 * session summary GraphQL query so the value is correct even if the user
 * minimized and reopened the overlay.
 */
export function SessionTimer({ startedAt, color }: SessionTimerProps) {
  const [now, setNow] = useState<number>(() => nowMs());

  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(nowMs()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;

  return (
    <Text variant="title2" color={color} style={{ fontVariant: ['tabular-nums'], fontWeight: '700' }}>
      {format(now - start)}
    </Text>
  );
}
