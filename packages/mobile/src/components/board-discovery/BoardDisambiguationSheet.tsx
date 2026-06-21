import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardCandidate } from '@boardsesh/shared-schema';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { Text } from '../Text';

type BoardDisambiguationSheetProps = {
  visible: boolean;
  candidates: BoardCandidate[];
  /** Confirm the board the user is at (by board id). */
  onPick: (boardId: number) => void;
  /** Dismiss without picking. */
  onCancel: () => void;
};

/**
 * Shown when a BLE serial maps to more than one board (the supplier reuses
 * serials, so a serial isn't a unique wall id). The user picks which wall
 * they're actually at; the choice is remembered so the prompt doesn't reappear.
 *
 * A plain RN `Modal` rather than a bottom-sheet so it works wherever a connect
 * happens (the provider is mounted above every screen) without a sheet host.
 */
export function BoardDisambiguationSheet({ visible, candidates, onPick, onCancel }: BoardDisambiguationSheetProps) {
  const { systemColors } = useTheme();
  const { t } = useTranslation('boards');

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable
          // Stop backdrop taps from closing when tapping the card itself.
          onPress={(event) => event.stopPropagation()}
          style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}
        >
          <Text variant="title3" style={styles.heading}>
            {t('mobile.disambiguation.title')}
          </Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.subheading}>
            {t('mobile.disambiguation.subtitle')}
          </Text>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {candidates.map((candidate) => {
              const location = candidate.gymName ?? candidate.locationName ?? null;
              return (
                <Pressable
                  key={candidate.boardId}
                  onPress={() => onPick(candidate.boardId)}
                  style={[styles.row, { borderColor: systemColors.separator }]}
                >
                  <View style={styles.rowText}>
                    <View style={styles.rowTitle}>
                      <Text variant="headline">{candidate.boardName}</Text>
                      {candidate.isOwnedByMe ? (
                        <View style={[styles.ownedPill, { backgroundColor: systemColors.fill }]}>
                          <Text variant="caption2" color={systemColors.secondaryLabel}>
                            {t('mobile.disambiguation.yourBoard')}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    <Text variant="subheadline" color={systemColors.secondaryLabel}>
                      {location ?? candidate.boardType}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>

          <Pressable onPress={onCancel} style={styles.cancel}>
            <Text variant="headline" color={systemColors.secondaryLabel}>
              {t('mobile.disambiguation.cancel')}
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  card: {
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
    padding: spacing[4],
    paddingBottom: spacing[8],
    maxHeight: '80%',
  },
  heading: {
    marginBottom: spacing[1],
  },
  subheading: {
    marginBottom: spacing[4],
  },
  list: {
    flexGrow: 0,
  },
  listContent: {
    gap: spacing[2],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowText: {
    flex: 1,
    gap: spacing[1],
  },
  rowTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  ownedPill: {
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.full,
  },
  cancel: {
    marginTop: spacing[4],
    alignItems: 'center',
    paddingVertical: spacing[3],
  },
});
