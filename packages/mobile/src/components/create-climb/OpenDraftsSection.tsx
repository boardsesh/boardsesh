import { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName, Climb, ClimbSearchInput } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import { CollapsibleSection } from '../CollapsibleSection';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { useSearchClimbs, useDeleteDraftClimb } from '../../lib/graphql/hooks';
import { spacing } from '../../theme/tokens';
import { DraftRow } from './DraftRow';

type BoardConfig = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

type OpenDraftsSectionProps = {
  board: BoardConfig;
  onLoadDraft: (climb: Climb) => void;
};

/**
 * Below-the-fold "Open drafts" table: the climber's saved drafts for the active
 * board, in a collapsible section. Tapping a row loads it into the editor; the
 * trash icon deletes it (with confirm). Reuses the drafts query + delete
 * mutation; the delete already invalidates the search cache, so the list
 * refreshes itself.
 */
export function OpenDraftsSection({ board, onLoadDraft }: OpenDraftsSectionProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const deleteDraft = useDeleteDraftClimb();

  // Defer the drafts query until the section is actually expanded. The drawer
  // opens at peek with this below the fold, so most opens never need it — the
  // old DraftsSheet likewise only fetched while visible.
  const [sectionOpen, setSectionOpen] = useState(false);

  const searchInput = useMemo<ClimbSearchInput>(
    () => ({
      boardName: board.boardName,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: board.setIds,
      angle: board.angle,
      page: 0,
      pageSize: 50,
      onlyDrafts: true,
      sortBy: 'creation',
      sortOrder: 'desc',
    }),
    [board.boardName, board.layoutId, board.sizeId, board.setIds, board.angle],
  );

  const { data, isLoading, isError } = useSearchClimbs(searchInput, sectionOpen);
  const drafts = data?.climbs ?? [];

  const handleDelete = useCallback(
    async (climb: Climb) => {
      const confirmed = await confirm({
        title: t('draftsDrawer.delete.title'),
        message: t('draftsDrawer.delete.description'),
        confirmLabel: t('draftsDrawer.delete.confirm'),
        cancelLabel: t('createClimbForm.dismiss'),
        destructive: true,
      });
      if (!confirmed) return;
      deleteDraft.mutate(
        { uuid: climb.uuid, boardType: board.boardName },
        {
          onSuccess: () => showToast(t('draftsDrawer.delete.success'), 'success'),
          onError: () => showToast(t('draftsDrawer.delete.error'), 'error'),
        },
      );
    },
    [confirm, board.boardName, deleteDraft, showToast, t],
  );

  const summary = drafts.length > 0 ? t('draftsDrawer.count', { count: drafts.length }) : null;

  return (
    <CollapsibleSection
      title={t('mobile.create.drafts.sectionTitle')}
      summary={summary}
      onExpandedChange={setSectionOpen}
    >
      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" />
        </View>
      ) : isError ? (
        <View style={styles.centered}>
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {t('draftsDrawer.loadError')}
          </Text>
        </View>
      ) : drafts.length === 0 ? (
        <View style={styles.centered}>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.emptyText}>
            {t('draftsDrawer.empty.title')}
          </Text>
        </View>
      ) : (
        <View>
          {drafts.map((climb) => (
            <DraftRow key={climb.uuid} climb={climb} onPress={onLoadDraft} onDelete={handleDelete} />
          ))}
        </View>
      )}
    </CollapsibleSection>
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing[6],
    gap: spacing[2],
  },
  emptyText: {
    textAlign: 'center',
  },
});
