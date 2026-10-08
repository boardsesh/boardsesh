import { Portal } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { spacing } from '../../theme/tokens';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { UndoSnackbar } from '../UndoSnackbar';

// Held longer than the queue-added snackbar (someone may be mid-route on the
// wall the user just changed) — the accidental-takeover safety net.
const UNDO_DURATION = 8000;

type UndoWallChangeSnackbarProps = {
  visible: boolean;
  /** Changes on each show so the timer resets + the entrance replays. */
  nonce: number;
  onDismiss: () => void;
  /** Re-light the previous wall climb and re-report it to the wall feed. */
  onUndo: () => void;
  duration?: number;
};

/**
 * "You changed the wall · Undo" snackbar. Fires right after THIS device reports
 * a wall change so the climber who just (maybe accidentally) re-lit the wall can
 * restore the previous climb with one tap. The Undo action re-sends the previous
 * wall climb — queue navigation is never touched. Portaled above the app chrome;
 * the body is the shared {@link UndoSnackbar}.
 */
export function UndoWallChangeSnackbar({ duration = UNDO_DURATION, ...props }: UndoWallChangeSnackbarProps) {
  const { t } = useTranslation('session');
  const bottomChrome = useBottomChromeMetrics();
  return (
    <Portal>
      <UndoSnackbar
        {...props}
        duration={duration}
        bottom={bottomChrome.floatingControlBottom + spacing[2]}
        message={t('mobile.boardPresence.wallChanged')}
        undoLabel={t('mobile.boardPresence.undo')}
        undoAccessibilityLabel={t('mobile.boardPresence.undoAria')}
      />
    </Portal>
  );
}
