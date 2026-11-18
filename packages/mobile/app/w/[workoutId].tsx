import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as WebBrowser from 'expo-web-browser';
import { GET_APP_WORKOUT } from '@boardsesh/graphql/operations/app-workouts';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useAuth } from '../../src/providers/auth-provider';
import { useAppWorkoutsFlag } from '../../src/providers/feature-flags-provider';
import { getHttpClient } from '../../src/lib/graphql/client';
import { getCredentialGeneration } from '../../src/lib/privacy/privacy-cache';
import {
  isAppWorkoutId,
  PENDING_APP_WORKOUT_KEY,
  serializePendingAppWorkout,
} from '../../src/lib/partner-workout-link';
import { activatePartnerWorkout, setPendingWorkout, type AppWorkout } from '../../src/lib/pending-workout-store';
import { useQueueSessionId } from '../../src/providers/queue-provider';
import { useActiveBoard } from '../../src/lib/graphql/use-active-board';
import { partnerWorkoutAnalytics } from '../../src/lib/partner-workout-analytics';
import { track } from '../../src/lib/analytics';
import { useConsentSettled } from '../../src/lib/consent-hooks';
import { Text } from '../../src/components/Text';
import { Button } from '../../src/components/Button';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { spacing } from '../../src/theme/tokens';
import { reportHandledError } from '../../src/lib/error-reporting';

function isAccountMismatch(error: unknown): boolean {
  const errors = (error as { response?: { errors?: { extensions?: { reason?: unknown } }[] } } | null)?.response
    ?.errors;
  return Array.isArray(errors) && errors.some((entry) => entry.extensions?.reason === 'APP_WORKOUT_ACCOUNT_MISMATCH');
}

export default function AppWorkoutRoute() {
  const { workoutId } = useLocalSearchParams<{ workoutId: string }>();
  const { t } = useTranslation('session');
  const { isAuthenticated, signOut } = useAuth();
  const enabled = useAppWorkoutsFlag();
  const consentSettled = useConsentSettled();
  const router = useRouter();
  const generation = getCredentialGeneration();
  const { sessionId } = useQueueSessionId();
  const { data: board } = useActiveBoard();
  const opened = useRef<string | null>(null);
  const query = useQuery({
    queryKey: ['appWorkout', generation, workoutId],
    enabled: enabled && isAuthenticated && consentSettled && isAppWorkoutId(workoutId),
    queryFn: async () =>
      (await getHttpClient().request<{ appWorkout: AppWorkout }>(GET_APP_WORKOUT, { id: workoutId })).appWorkout,
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  useEffect(() => {
    if (!enabled || isAuthenticated || !isAppWorkoutId(workoutId)) return;
    let cancelled = false;
    void AsyncStorage.setItem(PENDING_APP_WORKOUT_KEY, serializePendingAppWorkout(workoutId))
      .then(() => {
        if (!cancelled && generation === getCredentialGeneration()) router.replace('/auth/login');
      })
      .catch((error: unknown) => {
        reportHandledError(error, { tags: { source: 'partner-workout', op: 'stash-link' } });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, isAuthenticated, workoutId, router, generation]);
  useEffect(() => {
    if (
      !enabled ||
      query.isFetching ||
      query.isError ||
      !query.data ||
      !isAuthenticated ||
      !consentSettled ||
      generation !== getCredentialGeneration()
    )
      return;
    if (query.data.status === 'started' && query.data.sessionId === sessionId && sessionId) {
      activatePartnerWorkout(sessionId, query.data);
    } else if (query.data.status === 'created' || query.data.status === 'opened') {
      setPendingWorkout(query.data);
    } else return;
    if (opened.current !== query.data.id) {
      opened.current = query.data.id;
      track(SHARED_EVENTS.AppWorkoutOpened, partnerWorkoutAnalytics(query.data, board?.boardType ?? null));
    }
    router.replace('/(tabs)/record');
  }, [
    enabled,
    query.data,
    query.isFetching,
    query.isError,
    isAuthenticated,
    consentSettled,
    generation,
    router,
    sessionId,
    board?.boardType,
  ]);
  const switchAccount = async () => {
    await AsyncStorage.setItem(PENDING_APP_WORKOUT_KEY, serializePendingAppWorkout(workoutId));
    await signOut();
    router.replace('/auth/login');
  };
  const resumeSession = () => {
    const workout = query.data;
    if (
      !workout?.sessionId ||
      query.isFetching ||
      query.isError ||
      generation !== getCredentialGeneration() ||
      !isAuthenticated ||
      !consentSettled
    )
      return;
    // Joining owns confirmation, board resolution and the authoritative queue.
    // Reopening a link never appends a second copy of an existing workout.
    activatePartnerWorkout(workout.sessionId, workout);
    router.replace({ pathname: '/join/[sessionId]', params: { sessionId: workout.sessionId } });
  };
  return (
    <View style={styles.body}>
      <Stack.Screen options={{ title: t('partnerWorkouts.routeTitle') }} />
      {!enabled ? (
        <>
          <Text>{t('partnerWorkouts.unavailable')}</Text>
          {isAppWorkoutId(workoutId) ? (
            <Button
              title={t('partnerWorkouts.openWebsite')}
              onPress={() => {
                // An in-app browser avoids re-entering iOS's universal-link association.
                void WebBrowser.openBrowserAsync(`https://www.boardsesh.com/w/${workoutId}`).catch((error: unknown) => {
                  reportHandledError(error, { tags: { source: 'partner-workout', op: 'open-website' } });
                });
              }}
            />
          ) : null}
        </>
      ) : !isAppWorkoutId(workoutId) ? (
        <Text>{t('partnerWorkouts.loadError')}</Text>
      ) : isAccountMismatch(query.error) ? (
        <>
          <Text>{t('partnerWorkouts.wrongAccount')}</Text>
          <Button
            title={t('partnerWorkouts.switchAccount')}
            onPress={() => {
              void switchAccount();
            }}
          />
        </>
      ) : query.isError ? (
        <>
          <Text>{t('partnerWorkouts.loadError')}</Text>
          <Button
            title={t('partnerWorkouts.retry')}
            onPress={() => {
              void query.refetch();
            }}
          />
        </>
      ) : query.data?.status === 'started' && query.data.sessionId ? (
        <Button title={t('partnerWorkouts.resume')} onPress={resumeSession} />
      ) : query.data && !['created', 'opened'].includes(query.data.status) ? (
        <Text>{t('partnerWorkouts.finished')}</Text>
      ) : (
        <ActivityIndicator />
      )}
    </View>
  );
}
const styles = StyleSheet.create({ body: { flex: 1, padding: spacing[4], gap: spacing[4], justifyContent: 'center' } });
