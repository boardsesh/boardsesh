// "Ask Sam to climb here": a friend's board the viewer can't open yet. One
// decision, so a short sheet over the list (mobile-sheets-vs-routes.md, the
// short confirm sheets over the picker), modelled on WallNotListedConfirmSheet.
// Waiting on an answer, the same sheet offers to take the request back.
// Failures read inline: a toast would draw behind the boards modal.

import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { MEDIUM_SNAP_POINTS } from '../sheet-snap-points';

/**
 * Why the last ask or cancel didn't go through. `daily_cap` is the daily limit
 * on asks; `rate_limited` is any shorter wait.
 */
export type FriendBoardAccessError = 'daily_cap' | 'rate_limited' | 'offline' | 'failed';

type FriendBoardAccessSheetProps = {
  ownerName: string;
  /** The viewer already asked and the owner hasn't answered. */
  waiting: boolean;
  pending: boolean;
  error: FriendBoardAccessError | null;
  onAsk: () => void;
  onCancelRequest: () => void;
  onDismiss: () => void;
};

export function FriendBoardAccessSheet({
  ownerName,
  waiting,
  pending,
  error,
  onAsk,
  onCancelRequest,
  onDismiss,
}: FriendBoardAccessSheetProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const errorText =
    error === 'daily_cap'
      ? t('mobile.friendBoards.rateLimited')
      : error === 'rate_limited'
        ? t('mobile.friendBoards.tooManyTries')
        : error === 'offline'
          ? t('mobile.friendBoards.askOffline')
          : error === 'failed'
            ? t('mobile.friendBoards.askFailed')
            : null;

  return (
    <ModalSheet
      visible
      snapPoints={MEDIUM_SNAP_POINTS}
      enablePanDownToClose
      onClose={onDismiss}
      header={
        <SheetTopBar
          title={
            waiting
              ? t('mobile.friendBoards.waitingTitle', { name: ownerName })
              : t('mobile.friendBoards.askTitle', { name: ownerName })
          }
          leading={{ kind: 'close', onPress: onDismiss, accessibilityLabel: t('mobile.friendBoards.close') }}
        />
      }
    >
      <View style={styles.content} testID="friend-board-access-sheet">
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.centered}>
          {waiting
            ? t('mobile.friendBoards.waitingBody', { name: ownerName })
            : t('mobile.friendBoards.askBody', { name: ownerName })}
        </Text>
        {errorText ? (
          <Text
            variant="footnote"
            accessibilityRole="alert"
            color={brandColors.error}
            style={styles.centered}
            testID="friend-board-access-error"
          >
            {errorText}
          </Text>
        ) : null}
        {waiting ? (
          <Button
            title={t('mobile.friendBoards.cancelRequest')}
            onPress={onCancelRequest}
            variant="tonal"
            size="medium"
            loading={pending}
            disabled={pending}
            style={styles.fullWidth}
            testID="friend-board-cancel-request"
          />
        ) : (
          <Button
            title={t('mobile.friendBoards.ask')}
            onPress={onAsk}
            size="medium"
            loading={pending}
            disabled={pending}
            style={styles.fullWidth}
            testID="friend-board-ask"
          />
        )}
      </View>
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    gap: spacing[3],
  },
  centered: {
    textAlign: 'center',
  },
  fullWidth: {
    alignSelf: 'stretch',
  },
});
