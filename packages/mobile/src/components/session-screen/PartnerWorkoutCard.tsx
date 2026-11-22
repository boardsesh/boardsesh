import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getGradesForBoard, toBoardName } from '@boardsesh/board-config';
import { MAX_SYNCED_QUEUE_ITEMS } from '@boardsesh/queue';
import { MAX_SESSION_WORKOUT_ITEMS } from '@boardsesh/workout-summary';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  ATTACH_APP_WORKOUT,
  GET_APP_WORKOUT,
  RECORD_APP_WORKOUT_PLAN,
} from '@boardsesh/graphql/operations/app-workouts';
import { getActiveBoardWriteGeneration, useActiveBoard } from '../../lib/graphql/use-active-board';
import { getHttpClient } from '../../lib/graphql/client';
import { useQueueActions, useQueueSessionId } from '../../providers/queue-provider';
import type { StartSessionConfig } from '../../providers/queue-provider';
import { useAppWorkoutsFlag } from '../../providers/feature-flags-provider';
import { useToast } from '../../providers/toast-provider';
import { Card } from '../Card';
import { Text } from '../Text';
import { Button } from '../Button';
import { SwitchRow } from '../SwitchRow';
import { spacing } from '../../theme/tokens';
import { buildPartnerWorkoutPlan } from '../../lib/partner-workout-plan';
import {
  activatePartnerWorkout,
  clearPendingWorkout,
  setPendingWorkout,
  rememberPartnerWorkout,
  getPartnerWorkoutTimer,
  setPartnerWorkoutTimer,
  getPendingWorkout,
  useActivePartnerWorkout,
  usePendingWorkout,
  type AppWorkout,
} from '../../lib/pending-workout-store';
import { getCredentialGeneration } from '../../lib/privacy/privacy-cache';
import { fetchGradePool } from './pre-session/select-climbs-for-plan';
import { appendPartnerWorkout } from '../../lib/partner-workout-queue';
import { buildPartnerWorkoutPreview, reselectPartnerWorkoutPreview } from '../../lib/partner-workout-preview';
import { queuedClimbUuids } from './in-session/add-workout-block';
import { useSearchGradeSourceActive, useSearchGradeSourceSettled } from '../../lib/graphql/hooks/search-grade-source';
import {
  getWorkoutRunForSession,
  hydrateWorkoutRun,
  prepareWorkoutRun,
  setWorkoutRun,
} from '../../lib/workout-run-store';
import { captureWorkoutRunClimbs } from '../../lib/session-workout-plan';
import { enqueueSessionWorkoutWrite } from '../../offline/session-workout-outbox';
import { armRestTimerForAddedBlock } from '../../lib/arm-added-block-rest-timer';
import { nowMs } from '../../lib/clock';
import { reportHandledError } from '../../lib/error-reporting';
import { track } from '../../lib/analytics';
import { partnerWorkoutAnalytics } from '../../lib/partner-workout-analytics';
import { buildPartnerWorkoutInitialSeed, restorePartnerWorkoutRun } from '../../lib/partner-workout-initial-seed';

const launching = new Set<string>();

export function PartnerWorkoutCard({
  onEndCurrentSession,
  startConfig,
}: {
  onEndCurrentSession?: () => void;
  startConfig?: StartSessionConfig | null;
}) {
  const { t } = useTranslation('session');
  const router = useRouter();
  const enabled = useAppWorkoutsFlag();
  const pending = usePendingWorkout();
  const { sessionId } = useQueueSessionId();
  const active = useActivePartnerWorkout(sessionId);
  const workout = enabled ? (pending ?? active) : null;
  const requiresNewSession =
    sessionId !== null && pending?.spec.blocks.some((block) => block.type === 'fourByFour') === true;
  useEffect(() => {
    if (!enabled) clearPendingWorkout();
  }, [enabled]);
  const { data: board } = useActiveBoard();
  const { startSession, appendQueueItems, getQueueSnapshot } = useQueueActions();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [timer, setTimer] = useState<{ block: number; endsAt: number } | null>(null);
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    const savedTimer = sessionId && workout ? getPartnerWorkoutTimer(sessionId, workout.id) : null;
    setTimer(savedTimer && savedTimer.endsAt > Date.now() ? savedTimer : null);
    setRemaining(savedTimer ? Math.max(0, Math.ceil((savedTimer.endsAt - Date.now()) / 1000)) : 0);
  }, [workout?.id, sessionId]);
  const credentialGeneration = getCredentialGeneration();
  const winningPlan = useQuery({
    queryKey: ['partnerWorkoutWinningPlan', credentialGeneration, active?.id, sessionId],
    enabled: enabled && active !== null && sessionId !== null,
    queryFn: async () => {
      if (!active) throw new Error('No active partner workout');
      return (await getHttpClient().request<{ appWorkout: AppWorkout }>(GET_APP_WORKOUT, { id: active.id })).appWorkout;
    },
  });
  useEffect(() => {
    if (
      !active ||
      !sessionId ||
      winningPlan.data?.sessionId !== sessionId ||
      credentialGeneration !== getCredentialGeneration()
    )
      return;
    const restored = restorePartnerWorkoutRun(winningPlan.data.sessionPlan);
    if (!restored) return;
    let cancelled = false;
    // Read persisted local ticks before installing a server plan. A cold-start
    // hydrate in flight must not lose its log to this recovery write.
    void hydrateWorkoutRun(sessionId).then((outcome) => {
      if (
        cancelled ||
        outcome === 'failed' ||
        credentialGeneration !== getCredentialGeneration() ||
        getWorkoutRunForSession(sessionId)
      )
        return;
      // The server's committed plan owns queue-item identities after any lost reply.
      if (active.pendingNativeStart) prepareWorkoutRun(sessionId, restored.run, restored.climbs);
      else setWorkoutRun(sessionId, restored.run, restored.climbs);
    });
    return () => {
      cancelled = true;
    };
  }, [active, sessionId, winningPlan.data, credentialGeneration]);
  const boardseshGrades = useSearchGradeSourceActive();
  // Wait for the stored grade-source choice, so a cold open builds the preview once.
  const gradeSourceSettled = useSearchGradeSourceSettled();
  const grades = useMemo(() => {
    const boardName = board ? toBoardName(board.boardType) : null;
    return boardName ? getGradesForBoard(boardName) : null;
  }, [board]);
  const plan = useMemo(
    () =>
      pending && pending.status !== 'started' && grades
        ? buildPartnerWorkoutPlan(pending.spec, grades, pending.id)
        : null,
    [pending, grades],
  );
  // The app's own preview pipeline (`buildPartnerWorkoutPreview`). Added to a
  // running session, it passes over the climbs that session already queued, as
  // "Add a block" does; a new session starts from what the climber picked, as
  // the pre-session builder does.
  const preview = useQuery({
    queryKey: [
      'partnerWorkoutPreview',
      credentialGeneration,
      pending?.id,
      board,
      sessionId,
      boardseshGrades,
      pending?.spec.blocks,
    ],
    enabled:
      enabled &&
      gradeSourceSettled &&
      pending !== null &&
      pending.status !== 'started' &&
      board != null &&
      plan !== null,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!pending || !plan || !board || !grades) throw new Error('No workout board');
      return buildPartnerWorkoutPreview({
        spec: pending.spec,
        partnerPlan: plan,
        grades,
        ctx: {
          board,
          isAuthenticated: true,
          boardseshGrades,
          isCurrent: () => !signal.aborted && credentialGeneration === getCredentialGeneration(),
        },
        fetchPool: fetchGradePool,
        getAvoidedClimbUuids: sessionId ? () => queuedClimbUuids(getQueueSnapshot().queue) : undefined,
      });
    },
  });

  const setAdvanceAfterFalls = useCallback(
    (blockIndex: number, advanceAfterFalls: boolean) => {
      const current = getPendingWorkout();
      if (!current || current.id !== pending?.id || current.status === 'started' || launching.has(current.id)) return;
      setPendingWorkout({
        ...current,
        spec: {
          ...current.spec,
          blocks: current.spec.blocks.map((block, index) =>
            index === blockIndex &&
            (block.type === 'volume' ||
              block.type === 'pyramid' ||
              block.type === 'ladder' ||
              block.type === 'gradeFocus')
              ? { ...block, advanceOn: advanceAfterFalls ? 'tick' : 'send' }
              : block,
          ),
        },
      });
    },
    [pending?.id],
  );

  const start = useCallback(async () => {
    if (!pending || pending.status === 'started' || !board || !preview.data || launching.has(pending.id)) return;
    if (!sessionId && !startConfig) return;
    if (requiresNewSession) {
      showToast(t('partnerWorkouts.newSessionRequired'), 'info');
      return;
    }
    if (plan && plan.slots.length > 0 && preview.data.items.length === 0) return;
    if (
      (plan && preview.data.items.length < plan.slots.length) ||
      preview.data.items.length + getQueueSnapshot().queue.length > MAX_SYNCED_QUEUE_ITEMS ||
      preview.data.items.length +
        new Set(getWorkoutRunForSession(sessionId ?? '')?.stages.flatMap((stage) => stage.itemUuids) ?? []).size >
        MAX_SESSION_WORKOUT_ITEMS
    ) {
      showToast(t('partnerWorkouts.queueFull'), 'error');
      return;
    }
    const generation = getCredentialGeneration();
    const boardGeneration = getActiveBoardWriteGeneration();
    const intendedSessionId = sessionId;
    launching.add(pending.id);
    setBusy(true);
    const recoverCommittedWorkout = async (): Promise<boolean> => {
      const recovered = (await getHttpClient().request<{ appWorkout: AppWorkout }>(GET_APP_WORKOUT, { id: pending.id }))
        .appWorkout;
      if (generation !== getCredentialGeneration() || getPendingWorkout()?.id !== pending.id) return true;
      if (recovered.status !== 'started' || !recovered.sessionId) return false;
      await rememberPartnerWorkout(recovered.sessionId, recovered.id).catch((error: unknown) => {
        reportHandledError(error, { tags: { source: 'partner-workout', op: 'remember-committed' } });
      });
      if (generation !== getCredentialGeneration() || getPendingWorkout()?.id !== pending.id) return true;
      if (getQueueSnapshot().sessionId === recovered.sessionId) activatePartnerWorkout(recovered.sessionId, recovered);
      else setPendingWorkout(recovered);
      return true;
    };
    try {
      let attachedSessionId = intendedSessionId;
      if (attachedSessionId) {
        const hydrated = await hydrateWorkoutRun(attachedSessionId);
        if (hydrated === 'failed') throw new Error('The existing workout could not be read');
        if (
          generation !== getCredentialGeneration() ||
          boardGeneration !== getActiveBoardWriteGeneration() ||
          getQueueSnapshot().sessionId !== attachedSessionId
        )
          return;
        // Hydration can reveal a larger stored plan than the first render knew.
        const hydratedSnapshot = getQueueSnapshot();
        if (
          preview.data.items.length + hydratedSnapshot.queue.length > MAX_SYNCED_QUEUE_ITEMS ||
          preview.data.items.length +
            new Set(getWorkoutRunForSession(attachedSessionId)?.stages.flatMap((stage) => stage.itemUuids) ?? []).size >
            MAX_SESSION_WORKOUT_ITEMS
        ) {
          showToast(t('partnerWorkouts.queueFull'), 'error');
          return;
        }
        await getHttpClient().request(ATTACH_APP_WORKOUT, { workoutId: pending.id, sessionId: attachedSessionId });
        if (generation !== getCredentialGeneration()) return;
        await rememberPartnerWorkout(attachedSessionId, pending.id);
        if (getQueueSnapshot().sessionId !== attachedSessionId || boardGeneration !== getActiveBoardWriteGeneration()) {
          await recoverCommittedWorkout();
          return;
        }
      } else {
        const snapshot = getQueueSnapshot();
        if (snapshot.sessionId) return;
        const { seed, landedItems } = buildPartnerWorkoutInitialSeed({
          workoutId: pending.id,
          blockCount: pending.spec.blocks.length,
          items: preview.data.items,
          run: preview.data.run,
          queue: snapshot.queue,
          currentClimbQueueItem: snapshot.currentClimbQueueItem,
          historyCount: snapshot.historyCount,
        });
        if (preview.data.items.length > 0 && landedItems.length === 0) {
          showToast(t('partnerWorkouts.queueFull'), 'error');
          return;
        }
        attachedSessionId = await startSession({ ...startConfig, appWorkoutId: pending.id, appWorkoutSeed: seed });
        if (generation !== getCredentialGeneration() || getPendingWorkout()?.id !== pending.id) return;
        if (!attachedSessionId) {
          await recoverCommittedWorkout();
          return;
        }
        // Queue + attribution are already durable. Replay returns that winning
        // state; never append or persist this render's regenerated preview again.
        activatePartnerWorkout(attachedSessionId, {
          ...pending,
          status: 'started',
          sessionId: attachedSessionId,
          pendingNativeStart: true,
        });
        track(SHARED_EVENTS.AppWorkoutStarted, partnerWorkoutAnalytics(pending, board.boardType));
        if (landedItems.length < preview.data.items.length || (plan?.slots.length ?? 0) > MAX_SESSION_WORKOUT_ITEMS)
          showToast(
            t('partnerWorkouts.budgetShortfall', {
              found: landedItems.length,
              planned: plan?.slots.length ?? preview.data.items.length,
            }),
            'info',
          );
        return;
      }
      if (!attachedSessionId || generation !== getCredentialGeneration() || getPendingWorkout()?.id !== pending.id)
        return;
      const snapshot = getQueueSnapshot();
      if (snapshot.sessionId !== attachedSessionId) {
        await recoverCommittedWorkout();
        return;
      }
      if (boardGeneration !== getActiveBoardWriteGeneration()) {
        showToast(t('partnerWorkouts.startError'), 'error');
        return;
      }
      // "Add a block"'s rule: pass over the climbs the queue holds now (it can
      // have gained some since the preview was built), from the pools already
      // fetched. A crewmate's add still in flight can race it, as with Add a block.
      const attached = plan
        ? reselectPartnerWorkoutPreview(preview.data, pending.spec, plan.plan, queuedClimbUuids(snapshot.queue))
        : preview.data;
      // Attachment has committed. A non-round workout keeps whatever still fits
      // after peer additions or reselection, and records that honest partial plan.
      // Returning here would leave a started workout without a local run or plan.
      const {
        landedItems: items,
        partnerRun,
        combinedRun,
      } = appendPartnerWorkout({
        items: attached.items,
        run: attached.run,
        existingRun: getWorkoutRunForSession(attachedSessionId),
        appendQueueItems,
      });
      const plannedSlots = plan?.slots.length ?? preview.data.selectionSlots;
      if (items.length < plannedSlots)
        showToast(
          t('partnerWorkouts.budgetShortfall', {
            found: items.length,
            planned: plan?.slots.length ?? attached.items.length,
          }),
          'info',
        );
      const climbs = captureWorkoutRunClimbs(items);
      setWorkoutRun(attachedSessionId, combinedRun, climbs);
      // Retire Start as soon as the local queue/run are committed. A failed
      // persistence or response must never make a retry append these UUIDs twice.
      activatePartnerWorkout(attachedSessionId, { ...pending, status: 'started', sessionId: attachedSessionId });
      track(SHARED_EVENTS.AppWorkoutStarted, partnerWorkoutAnalytics(pending, board.boardType));
      // The partner block's own pacing, and never while a workout waits for its Start.
      armRestTimerForAddedBlock(attachedSessionId, partnerRun, nowMs());
      // This durable write also reconstructs the partner snapshot after a lost response.
      await enqueueSessionWorkoutWrite(attachedSessionId, { queryClient, queueItems: getQueueSnapshot().queue }).catch(
        (error: unknown) => {
          reportHandledError(error, { tags: { source: 'partner-workout', op: 'queue-plan-write' } });
          showToast(t('partnerWorkouts.syncError'), 'error');
        },
      );
      const byUuid = new Map(items.map((item) => [item.uuid, item.climb.uuid]));
      const recordedPlan = pending.spec.blocks.map((_block, index) => ({
        index,
        climbUuids:
          partnerRun.stages
            .find((stage) => stage.id === `${pending.id}:${index}`)
            ?.itemUuids.flatMap((uuid) => byUuid.get(uuid) ?? []) ?? [],
      }));
      if (generation !== getCredentialGeneration()) return;
      // The session-workout outbox is the durable recovery path if this request fails.
      await getHttpClient()
        .request(RECORD_APP_WORKOUT_PLAN, { workoutId: pending.id, plan: recordedPlan })
        .catch((error: unknown) => {
          reportHandledError(error, { tags: { source: 'partner-workout', op: 'record-plan' } });
        });
      if (generation !== getCredentialGeneration()) return;
    } catch (error) {
      if (generation !== getCredentialGeneration()) return;
      const reasons = (error as { response?: { errors?: { extensions?: { reason?: string } }[] } } | null)?.response
        ?.errors;
      if (reasons?.some((entry) => entry.extensions?.reason === 'APP_WORKOUT_NEW_SESSION_REQUIRED')) {
        showToast(t('partnerWorkouts.newSessionRequired'), 'info');
        return;
      }
      if (reasons?.some((entry) => entry.extensions?.reason === 'APP_WORKOUT_PERMANENT_SESSION')) {
        showToast(t('partnerWorkouts.personalSessionRequired'), 'error');
        return;
      }
      try {
        if (await recoverCommittedWorkout()) return;
      } catch {
        /* A later retry refetches before appending. */
      }
      reportHandledError(error, { tags: { source: 'partner-workout', op: 'start' } });
      showToast(t('partnerWorkouts.startError'), 'error');
    } finally {
      launching.delete(pending.id);
      setBusy(false);
    }
  }, [
    pending,
    board,
    preview.data,
    plan,
    sessionId,
    startSession,
    getQueueSnapshot,
    appendQueueItems,
    queryClient,
    showToast,
    t,
    startConfig,
    requiresNewSession,
  ]);

  // Timer polling is mounted only while a free-climbing countdown is running.
  const endTimer = useCallback(() => {
    setTimer(null);
    if (sessionId && workout) void setPartnerWorkoutTimer(sessionId, workout.id, null).catch(() => undefined);
  }, [sessionId, workout]);
  usePartnerCountdown(timer?.endsAt ?? null, setRemaining, endTimer);
  if (!workout) return null;
  const nativeUnavailable = (plan?.slots.length ?? 0) > 0 && preview.data?.items.length === 0;
  return (
    <Card>
      <View style={styles.body}>
        <Text variant="footnote">{t('partnerWorkouts.from', { app: workout.sourceAppName })}</Text>
        <Text variant="title3" emphasized>
          {workout.title}
        </Text>
        {workout.notes ? <Text>{workout.notes}</Text> : null}
        {workout.spec.blocks.map((block, index) => (
          <View key={`${workout.id}:${index}`} style={styles.block}>
            <Text emphasized>{block.label ?? t(`partnerWorkouts.blocks.${block.type}`)}</Text>
            {'targetGrade' in block ? (
              <Text variant="footnote">
                {t('partnerWorkouts.targetGrade', {
                  grade: block.targetGrade.scale === 'v' ? `V${block.targetGrade.value}` : block.targetGrade.value,
                })}
              </Text>
            ) : null}
            {'climbCount' in block ? (
              <Text variant="footnote">{t('partnerWorkouts.climbCount', { count: block.climbCount })}</Text>
            ) : null}
            {block.type === 'fourByFour' ? (
              <Text variant="footnote">
                {t('partnerWorkouts.rounds', {
                  count: block.rounds,
                  climbRest: block.restBetweenClimbsSeconds,
                  roundRest: block.restBetweenRoundsSeconds,
                })}
              </Text>
            ) : null}
            {'restSeconds' in block && block.restSeconds !== undefined ? (
              <Text variant="footnote">{t('partnerWorkouts.rest', { seconds: block.restSeconds })}</Text>
            ) : null}
            {pending &&
            pending.status !== 'started' &&
            (block.type === 'volume' ||
              block.type === 'pyramid' ||
              block.type === 'ladder' ||
              block.type === 'gradeFocus') &&
            block.restSeconds !== undefined ? (
              <SwitchRow
                label={t('partnerWorkouts.advanceAfterFalls')}
                description={t('partnerWorkouts.advanceAfterFallsHint')}
                wrapDescription
                value={(block.advanceOn ?? 'tick') === 'tick'}
                onValueChange={(advanceAfterFalls) => setAdvanceAfterFalls(index, advanceAfterFalls)}
                disabled={busy}
              />
            ) : null}
            {block.instructions ? <Text>{block.instructions}</Text> : null}
            {block.type === 'limitBouldering' ? <Text variant="footnote">{t('partnerWorkouts.freeform')}</Text> : null}
            {plan?.clampedBlocks.includes(index) ? (
              <Text variant="footnote">{t('partnerWorkouts.clamped')}</Text>
            ) : null}
            {block.type === 'freeClimbing' && block.durationSeconds && !pending ? (
              <Button
                variant="outlined"
                title={
                  timer?.block === index
                    ? t('partnerWorkouts.countdown', { seconds: remaining })
                    : t('partnerWorkouts.startTimer')
                }
                onPress={() => {
                  const seconds = block.durationSeconds!;
                  setRemaining(seconds);
                  const countdown = { block: index, endsAt: Date.now() + seconds * 1000 };
                  setTimer(countdown);
                  if (sessionId)
                    void setPartnerWorkoutTimer(sessionId, workout.id, countdown).catch((error: unknown) => {
                      reportHandledError(error, { tags: { source: 'partner-workout', op: 'save-timer' } });
                    });
                }}
              />
            ) : null}
          </View>
        ))}
        {pending?.status === 'started' ? (
          <Button
            title={t('partnerWorkouts.resume')}
            onPress={() => {
              router.navigate({ pathname: '/w/[workoutId]', params: { workoutId: pending.id } });
            }}
          />
        ) : pending ? (
          <>
            {!board ? <Text>{t('partnerWorkouts.chooseBoard')}</Text> : null}
            {requiresNewSession ? <Text>{t('partnerWorkouts.newSessionRequired')}</Text> : null}
            {!sessionId && !startConfig ? <Text>{t('partnerWorkouts.privacyLoading')}</Text> : null}
            {preview.isError ? (
              <Button
                variant="outlined"
                title={t('partnerWorkouts.retry')}
                onPress={() => {
                  void preview.refetch();
                }}
              />
            ) : null}
            {nativeUnavailable ? <Text>{t('partnerWorkouts.noClimbs')}</Text> : null}
            {preview.data && plan && preview.data.items.length < preview.data.selectionSlots && !nativeUnavailable ? (
              <Text>
                {t('partnerWorkouts.shortfall', {
                  found: preview.data.items.length,
                  planned: preview.data.selectionSlots,
                })}
              </Text>
            ) : null}
            {plan && plan.slots.length > MAX_SESSION_WORKOUT_ITEMS ? (
              <Text>
                {t('partnerWorkouts.budgetShortfall', { found: MAX_SESSION_WORKOUT_ITEMS, planned: plan.slots.length })}
              </Text>
            ) : null}
            <Button
              title={sessionId ? t('partnerWorkouts.add') : t('partnerWorkouts.start')}
              onPress={() => {
                void start();
              }}
              loading={busy}
              disabled={
                busy ||
                requiresNewSession ||
                !board ||
                !preview.data ||
                nativeUnavailable ||
                (plan !== null &&
                  (plan.slots.length > MAX_SESSION_WORKOUT_ITEMS ||
                    (preview.data?.items.length ?? 0) < plan.slots.length)) ||
                (!sessionId && !startConfig)
              }
            />
            {sessionId && onEndCurrentSession ? (
              <Button
                variant="outlined"
                title={t('partnerWorkouts.endCurrent')}
                onPress={onEndCurrentSession}
                disabled={busy}
              />
            ) : null}
            <Button variant="text" title={t('partnerWorkouts.dismiss')} onPress={clearPendingWorkout} disabled={busy} />
          </>
        ) : null}
      </View>
    </Card>
  );
}

function usePartnerCountdown(endsAt: number | null, onTick: (seconds: number) => void, onEnd: () => void) {
  useEffect(() => {
    if (endsAt === null) return;
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      onTick(seconds);
      if (seconds === 0) onEnd();
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [endsAt, onTick, onEnd]);
}
const styles = StyleSheet.create({ body: { gap: spacing[3] }, block: { gap: spacing[1] } });
