import { lazy, Suspense, useEffect } from 'react';
import { GET_APP_WORKOUT } from '@boardsesh/graphql/operations/app-workouts';
import { getCredentialGeneration } from '../../lib/privacy/privacy-cache';
import { hydratePartnerWorkout, type AppWorkout } from '../../lib/pending-workout-store';
import { useAppWorkoutsFlag } from '../../providers/feature-flags-provider';
import { reportHandledError } from '../../lib/error-reporting';
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
  const enabled = useAppWorkoutsFlag();
  const credentialGeneration = getCredentialGeneration();
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void hydratePartnerWorkout(
      sessionId,
      async (id) => {
        const { getHttpClient } = await import('../../lib/graphql/client');
        return (await getHttpClient().request<{ appWorkout: AppWorkout }>(GET_APP_WORKOUT, { id })).appWorkout;
      },
      () => !cancelled,
    ).catch((error: unknown) => reportHandledError(error, { tags: { source: 'partner-workout', op: 'restore' } }));
    return () => {
      cancelled = true;
    };
  }, [enabled, sessionId, credentialGeneration]);
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
