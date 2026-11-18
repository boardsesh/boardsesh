import { lazy, Suspense } from 'react';
import { StyleSheet, View } from 'react-native';
import { useActivePartnerWorkout, usePendingWorkout } from '../../lib/pending-workout-store';
import { spacing } from '../../theme/tokens';
import type { StartSessionConfig } from '../../providers/queue-provider';

// Keep search clients and generation machinery unloaded until a partner card is visible.
const PartnerWorkoutCard = lazy(() =>
  import('./PartnerWorkoutCard').then((module) => ({ default: module.PartnerWorkoutCard })),
);

export function PartnerWorkoutEntry({
  sessionId = null,
  inset = false,
  onEndCurrentSession,
  startConfig,
}: {
  sessionId?: string | null;
  inset?: boolean;
  onEndCurrentSession?: () => void;
  startConfig?: StartSessionConfig | null;
}) {
  const pending = usePendingWorkout();
  const active = useActivePartnerWorkout(sessionId);
  return pending || active ? (
    <View style={inset ? styles.inset : undefined}>
      <Suspense fallback={null}>
        <PartnerWorkoutCard onEndCurrentSession={onEndCurrentSession} startConfig={startConfig} />
      </Suspense>
    </View>
  ) : null;
}

const styles = StyleSheet.create({ inset: { paddingHorizontal: spacing[4] } });
