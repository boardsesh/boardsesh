import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getGradesForBoard, toBoardName } from '@boardsesh/board-config';
import { generateWorkoutPlan } from '@boardsesh/playlist-generator';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../../lib/analytics';
import { Button } from '../../Button';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { useActiveBoard } from '../../../lib/graphql/use-active-board';
import { useAuth } from '../../../providers/auth-provider';
import { useQueueActions } from '../../../providers/queue-provider';
import { useToast } from '../../../providers/toast-provider';
import { useBottomChromeMetrics } from '../../../hooks/use-bottom-chrome-metrics';
import { BoardSummaryCard } from './BoardSummaryCard';
import { GeneratorPickerCard, type GeneratorSelection } from './GeneratorPickerCard';
import { selectClimbsForPlan } from './select-climbs-for-plan';

/**
 * First screen of the session overlay before a session is live: pick a board,
 * optionally generate a workout from the shared playlist generator, and tap
 * Start. Pressing Start lazily creates the session via the queue provider; the
 * SessionScreen then re-renders into InSessionView because `sessionId` flips.
 */
export function PreSessionView() {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  const { data: activeBoard } = useActiveBoard();
  const { isAuthenticated } = useAuth();
  const { startSession, addToQueue } = useQueueActions();
  const { showToast } = useToast();

  const [selection, setSelection] = useState<GeneratorSelection>({ type: 'off' });
  const [isStarting, setIsStarting] = useState(false);

  const handleStart = useCallback(async () => {
    if (!activeBoard) return;
    setIsStarting(true);
    try {
      const newSessionId = await startSession();
      if (!newSessionId) {
        // startSession already toasted on failure; just bail.
        return;
      }

      if (selection.type === 'on') {
        const boardName = toBoardName(activeBoard.boardType);
        if (!boardName) return;
        const grades = getGradesForBoard(boardName);
        const plan = generateWorkoutPlan(selection.options, grades);
        if (plan.length > 0) {
          const { minAscents, minRating, onlyTallClimbs, climbBias } = selection.options;
          const items = await selectClimbsForPlan(plan, activeBoard, {
            isAuthenticated,
            filters: { minAscents, minRating, onlyTallClimbs, climbBias },
          });
          // addToQueue dispatches optimistically + fires the server mutation
          // through the existing queue-provider plumbing, so the queue echoes
          // through the WS subscription exactly like a manual add.
          items.forEach((item) => addToQueue(item));
          // Mirror web's start-sesh-drawer `Session Queue Generated`. The mobile
          // path adds every selected climb (no per-slot failure tracking), so
          // savedCount is the queued count and failedCount is the planned-minus-
          // queued shortfall when the catalog couldn't fill every slot.
          track(SHARED_EVENTS.SessionQueueGenerated, {
            workoutType: selection.options.type,
            boardName: activeBoard.boardType,
            angle: activeBoard.angle,
            savedCount: items.length,
            failedCount: plan.length - items.length,
          });
        }
      }
    } catch {
      showToast(t('mobile.session.preStartError'), 'error');
    } finally {
      setIsStarting(false);
    }
  }, [activeBoard, isAuthenticated, selection, startSession, addToQueue, showToast, t]);

  const canStart = activeBoard != null && !isStarting;
  const footerBottomPadding = bottomChrome.scrollBottomPadding + spacing[3];

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: 100 + footerBottomPadding }]}
        showsVerticalScrollIndicator={false}
      >
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.eyebrow}>
          {t('mobile.session.headerStart')}
        </Text>

        <BoardSummaryCard board={activeBoard ?? null} />

        <GeneratorPickerCard
          boardName={activeBoard ? toBoardName(activeBoard.boardType) : null}
          angle={activeBoard?.angle ?? null}
          selection={selection}
          onChange={setSelection}
        />
      </ScrollView>

      <View style={[styles.footer, { backgroundColor: systemColors.background, paddingBottom: footerBottomPadding }]}>
        <Button
          title={isStarting ? t('mobile.session.preStarting') : t('mobile.session.preStart')}
          onPress={() => void handleStart()}
          variant="filled"
          size="large"
          disabled={!canStart}
          loading={isStarting}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    gap: spacing[4],
  },
  eyebrow: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
  },
});
