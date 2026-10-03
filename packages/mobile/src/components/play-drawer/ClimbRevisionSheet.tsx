// One earlier version of a climb, to look at (#5955).
//
// Read-only by construction: this file imports nothing from the queue, the
// Bluetooth provider or the create-climb editor, so there is no restore, no
// "add to queue" and no light-up to reach by accident. An old version of a climb
// is a record of what the wall looked like, not something to send to it.
//
// Driven by a controlled `visible` prop and mounted in-tree by the play drawer
// (beside AddBetaVideoSheet), so it presents ABOVE the `/play` modal. A root
// sheet would present behind it (`docs/mobile-sheets-vs-routes.md`).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getDisplayDescription, type BoardName, type Climb } from '@boardsesh/shared-schema';
import type { ClimbRevisionRow } from '@boardsesh/graphql/operations/climb-revisions';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { Button } from '../Button';
import { Avatar } from '../Avatar';
import { OfflineState } from '../OfflineState';
import { BoardImageNative } from '../BoardImageNative';
import { SprayRevisionBoard } from './SprayRevisionBoard';
import { formatRevisionDate, pickRevisionBoardPath } from './revisions-view';
import { useClimbRevisions } from '../../lib/graphql/hooks/use-climb-revisions';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { getBoardRenderData } from '../../lib/board-details';
import { getSprayWall } from '../../lib/spray/spray-wall-registry';
import { useSprayWallToken } from '../../lib/spray/use-spray-wall-token';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';

type ClimbRevisionSheetProps = {
  visible: boolean;
  /** The climb whose history this is. Pinned by the drawer when the sheet opens. */
  climb: Climb | null;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  /** The revision the row that was tapped stands for. */
  revisionNumber: number | null;
  onClose: () => void;
};

const SNAP_POINTS = ['90%'];

export function ClimbRevisionSheet({
  visible,
  climb,
  boardName,
  layoutId,
  sizeId,
  setIds,
  revisionNumber,
  onClose,
}: ClimbRevisionSheetProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const { formatGradeByDifficultyId } = useGradeFormat();

  // The same key the section reads, so opening a row costs no second request.
  const revisionsQuery = useClimbRevisions(boardName, climb?.uuid ?? '', visible && !!climb);
  const offline = useOfflineQueryState(revisionsQuery);
  const revisions = revisionsQuery.data;

  // Which revision is on screen. Seeded from the tapped row each time the sheet
  // opens; Older / Newer move it without the drawer hearing about it.
  const [selectedNumber, setSelectedNumber] = useState<number | null>(revisionNumber);
  useEffect(() => {
    if (visible) setSelectedNumber(revisionNumber);
  }, [visible, revisionNumber]);

  // Newest first, as the server returns them. A number that is no longer in the
  // list (pruned at the cap between the tap and the read) falls back to the top.
  const selectedIndex = useMemo(() => {
    if (!revisions || revisions.length === 0) return -1;
    const found = revisions.findIndex((row) => row.revisionNumber === selectedNumber);
    return found === -1 ? 0 : found;
  }, [revisions, selectedNumber]);
  const revision: ClimbRevisionRow | null = selectedIndex >= 0 && revisions ? revisions[selectedIndex] : null;
  const total = revisions?.length ?? 0;

  const handleOlder = useCallback(() => {
    const older = revisions?.[selectedIndex + 1];
    if (older) setSelectedNumber(older.revisionNumber);
  }, [revisions, selectedIndex]);
  const handleNewer = useCallback(() => {
    const newer = revisions?.[selectedIndex - 1];
    if (newer) setSelectedNumber(newer.revisionNumber);
  }, [revisions, selectedIndex]);

  // Re-render when the wall registers or is reset; the token itself is what the
  // native path's memo keys move on.
  const sprayToken = useSprayWallToken(boardName, layoutId);
  const registeredWall = boardName === 'spray' ? getSprayWall(layoutId) : null;
  const boardPath = pickRevisionBoardPath({
    boardName,
    revisionWallVersion: revision?.sprayWallVersionNumber ?? null,
    registeredWallVersion: registeredWall?.version ?? null,
  });

  const boardRenderData = useMemo(
    () => getBoardRenderData({ boardName, layoutId, sizeId, setIds: setIds.split(',').map(Number) }),
    // `sprayToken` recomputes this when the wall lands or is reset.
    [boardName, layoutId, sizeId, setIds, sprayToken],
  );

  const footer = useMemo(
    () =>
      total > 1 ? (
        <View style={styles.footer}>
          <Button
            title={t('mobile.revisions.sheet.older')}
            variant="tonal"
            size="small"
            icon="chevron.left"
            disabled={selectedIndex >= total - 1}
            onPress={handleOlder}
          />
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('mobile.revisions.sheet.position', { position: total - selectedIndex, total })}
          </Text>
          <Button
            title={t('mobile.revisions.sheet.newer')}
            variant="tonal"
            size="small"
            disabled={selectedIndex <= 0}
            onPress={handleNewer}
          />
        </View>
      ) : undefined,
    [total, selectedIndex, handleOlder, handleNewer, systemColors.secondaryLabel, t],
  );

  const notes = revision ? getDisplayDescription(revision.description) : null;
  const gradeLabel = revision?.difficultyId != null ? formatGradeByDifficultyId(revision.difficultyId) : null;
  const frames = revision?.frames ?? '';

  let board = null;
  if (revision && climb) {
    if (boardPath === 'oldSprayVersion' && registeredWall && revision.sprayWallVersionNumber != null) {
      board = (
        <SprayRevisionBoard
          wallUuid={registeredWall.wallUuid}
          version={revision.sprayWallVersionNumber}
          frames={frames}
        />
      );
    } else if (boardPath === 'unavailable') {
      board = (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.boardNote}>
          {t('mobile.revisions.sheet.photoUnavailable')}
        </Text>
      );
    } else if (boardRenderData && frames) {
      // Not `playSurface`: this is a picture of the past, not the board the
      // climber is on, and must not count toward the play render-failure rate.
      board = (
        <BoardImageNative
          frames={frames}
          boardName={boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          boardWidth={boardRenderData.boardWidth}
          boardHeight={boardRenderData.boardHeight}
          recyclingKey={`${climb.uuid}-${revision.revisionNumber}`}
        />
      );
    } else {
      board = (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.boardNote}>
          {t('mobile.revisions.sheet.boardUnavailable')}
        </Text>
      );
    }
  }

  return (
    <ModalSheet visible={visible && !!climb} snapPoints={SNAP_POINTS} onClose={onClose} scrollable footer={footer}>
      {offline.isBlocked && offline.reason ? (
        <OfflineState reason={offline.reason} onRetry={revisionsQuery.refetch} />
      ) : revision ? (
        <View style={styles.body}>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('mobile.revisions.sheet.title', { date: formatRevisionDate(revision.createdAt) })}
            {revision.isCurrent ? ` · ${t('mobile.revisions.current')}` : ''}
          </Text>
          <Text variant="title3">{revision.name ?? climb?.name ?? ''}</Text>

          <View style={styles.metaRow}>
            {boardName === 'spray' ? (
              <Text variant="subheadline">{gradeLabel ?? t('mobile.revisions.sheet.noGrade')}</Text>
            ) : null}
            {revision.angle != null ? (
              <Text variant="subheadline" color={systemColors.secondaryLabel}>
                {t('mobile.revisions.sheet.angle', { angle: revision.angle })}
              </Text>
            ) : null}
          </View>

          <View style={styles.editorRow}>
            <Avatar uri={revision.editor?.avatarUrl} name={revision.editor?.displayName} size={24} />
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.editorText}>
              {revision.editor
                ? t('mobile.revisions.sheet.by', {
                    // A climber's own name: on screen as typed, never through a catalog.
                    editor: revision.editor.displayName ?? t('mobile.revisions.deletedEditor'),
                    role: revision.editedBySetter
                      ? t('mobile.revisions.tagSetter')
                      : t('mobile.revisions.tagWallOwner'),
                  })
                : t('mobile.revisions.deletedEditor')}
            </Text>
          </View>

          <View style={[styles.board, { backgroundColor: systemColors.tertiaryBackground }]}>{board}</View>

          {notes ? (
            <Text variant="subheadline" selectable>
              {notes}
            </Text>
          ) : null}

          {revision.isCurrent ? null : (
            <Text variant="caption1" color={systemColors.secondaryLabel}>
              {t('mobile.revisions.sheet.readOnly')}
            </Text>
          )}
        </View>
      ) : null}
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: spacing[4],
    gap: spacing[2],
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  editorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  editorText: {
    flexShrink: 1,
  },
  board: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    marginVertical: spacing[2],
  },
  boardNote: {
    padding: spacing[3],
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
});
