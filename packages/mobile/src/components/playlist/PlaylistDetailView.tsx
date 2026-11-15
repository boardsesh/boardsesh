import type { Climb } from '@boardsesh/queue';
import type { BoardName, Climb as SchemaClimb } from '@boardsesh/shared-schema';
import { useNavigation, useRouter } from 'expo-router';
import { useCallback, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions, View } from 'react-native';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useTypographyStyles } from '../../hooks/use-typography-styles';
import { useClimbRowDisplay, useClimbRowField } from '../../lib/climb-row-display-preference';
import { climbToQueueItem } from '../../lib/climb-to-queue-item';
import { toQueueClimb, toSchemaClimb } from '../../lib/climb-types';
import {
  getPlaylistRenderBoardTarget,
  resolvePlaylistClimbRenderBoard,
} from '../../lib/playlists/playlist-climb-render-board';
import type { PlaylistRenderBoard } from '../../lib/playlists/use-playlist-render-board';
import { ClimbProgressProvider, type ClimbProgressTarget } from '../../providers/climb-progress-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useQueueActions } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { ActiveAwareClimbListRow } from '../ActiveAwareClimbListRow';
import { ClimbListRowSkeleton } from '../ClimbListRowSkeleton';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { useClimbListThumbnailSize } from '../climb-list-thumbnail-metrics';
import {
  climbRowReorderHeight,
  climbRowSeparatorInset,
  DEFAULT_CLIMB_ROW_SURFACE,
  type ClimbRowReorderRow,
} from '../climb-row-layout';
import type { WindowAnchorPoint } from '../navigation/AnchoredPopover.types';
import { PlaylistBoardBackdrop } from './PlaylistBoardBackdrop';
import { PlaylistDetailPresentation, type PlaylistDetailViewProps } from './PlaylistDetailPresentation';
import { PlaylistEditClimbRow, type PlaylistEditRowBoard } from './PlaylistEditClimbRow';
import { createStyles } from './playlist-detail-styles';
import { usePlaylistDrag } from './use-playlist-drag';
export type {
  PlaylistDetailEmptyAction,
  PlaylistDetailEmptyState,
  PlaylistDetailFilterAction,
  PlaylistDetailHero,
  PlaylistDetailViewProps,
} from './PlaylistDetailPresentation';
const SKELETON_ROW_COUNT = 8;
const noopReorder = () => {};
const noopRemove = () => {};

type ResolvedPlaylistClimbRow =
  | {
      kind: 'renderable';
      renderBoard: PlaylistRenderBoard;
      editBoard: PlaylistEditRowBoard;
      incompatible: boolean;
    }
  | {
      kind: 'unrenderable';
    };

export function PlaylistDetailView(props: PlaylistDetailViewProps) {
  const { climbs, renderBoard, onActivateClimb, editMode = false, onReorderClimb, onRemoveClimb, hero } = props;
  const { fontScale } = useWindowDimensions();
  const { textStyles } = useTheme();
  const rowDisplay = useClimbRowDisplay();
  const bottomChrome = useBottomChromeMetrics();
  const router = useRouter();
  const navigation = useNavigation();
  // Stable per-row activate handler so the memoized `ClimbListRow`s aren't handed
  // a fresh closure each render — every renderItem rebuild (e.g. when the sticky
  // header `collapsed` flips during scroll) would otherwise re-render every row.
  const { getClimbActions, openAddToPlaylist } = useDrawerHost();
  const { playNext } = useQueueActions();
  const handleActivate = useCallback((tapped: SchemaClimb) => onActivateClimb(toQueueClimb(tapped)), [onActivateClimb]);
  // A row's right swipe is Play next, the same as in search (#6772).
  const handlePlayNext = useCallback(
    (climb: SchemaClimb) => {
      void playNext({ item: climbToQueueItem(climb) });
    },
    [playNext],
  );

  // List-level drag-to-reorder for edit mode. Always instantiated (hooks can't be
  // conditional); only the edit rows wire up its handles. `isDragging` locks the
  // list scroll while a row is lifted so scroll never fights the drag.
  const { isDragging, controls: dragControls } = usePlaylistDrag({
    reorder: onReorderClimb ?? noopReorder,
    itemCount: climbs.length,
  });

  const resolvedRowsByClimbUuid = useMemo(() => {
    const resolvedRows = new Map<string, ResolvedPlaylistClimbRow>();
    const activeBoardTarget = renderBoard ? getPlaylistRenderBoardTarget(renderBoard) : undefined;

    for (const climb of climbs) {
      const resolvedBoard = resolvePlaylistClimbRenderBoard(climb, renderBoard, activeBoardTarget);
      if (!resolvedBoard) {
        resolvedRows.set(climb.uuid, { kind: 'unrenderable' });
        continue;
      }

      const board = resolvedBoard.renderBoard;
      resolvedRows.set(climb.uuid, {
        kind: 'renderable',
        renderBoard: board,
        editBoard: {
          boardName: board.boardName as BoardName,
          layoutId: board.layoutId,
          sizeId: board.sizeId,
          setIds: board.setIds,
          angle: board.angle,
        },
        incompatible: resolvedBoard.incompatible,
      });
    }
    return resolvedRows;
  }, [climbs, renderBoard]);

  const editRowHeight = useMemo(() => {
    if (!editMode) return undefined;
    const rowShapes: ClimbRowReorderRow[] = [];
    for (const climb of climbs) {
      const resolved = resolvedRowsByClimbUuid.get(climb.uuid);
      const statsAngle = 'statsAngle' in climb ? climb.statsAngle : null;
      rowShapes.push({
        supportsMirroring: false,
        unrenderable: resolved?.kind === 'unrenderable',
        hasSetAngleMarker:
          resolved?.kind === 'renderable' &&
          typeof statsAngle === 'number' &&
          statsAngle !== resolved.renderBoard.angle,
      });
    }
    return climbRowReorderHeight({
      rows: rowShapes,
      display: rowDisplay,
      surface: { ...DEFAULT_CLIMB_ROW_SURFACE, showAscentStatus: false },
      fontScale,
      typeScale: textStyles,
    });
  }, [editMode, climbs, resolvedRowsByClimbUuid, rowDisplay, fontScale, textStyles]);

  const progressTargets = useMemo<ClimbProgressTarget[]>(() => {
    const targets: ClimbProgressTarget[] = [];
    for (const [climbUuid, row] of resolvedRowsByClimbUuid) {
      if (row.kind === 'renderable') targets.push({ boardName: row.renderBoard.boardName as BoardName, climbUuid });
    }
    return targets;
  }, [resolvedRowsByClimbUuid]);

  // Long press → climb menu, using the row's resolved render board (a playlist can
  // mix boards, so this isn't always the active board).
  const handleOpenActions = useCallback(
    (tapped: SchemaClimb) => {
      const resolved = resolvedRowsByClimbUuid.get(tapped.uuid);
      if (!resolved || resolved.kind !== 'renderable') return;
      const { boardName, layoutId, sizeId, setIds, angle } = resolved.renderBoard;
      return getClimbActions(tapped, { boardName, layoutId, sizeId, setIds, angle });
    },
    [getClimbActions, resolvedRowsByClimbUuid],
  );
  const handleOpenPlaylist = useCallback(
    (climb: SchemaClimb, anchorPoint?: WindowAnchorPoint) => {
      const resolved = resolvedRowsByClimbUuid.get(climb.uuid);
      if (!resolved || resolved.kind !== 'renderable') return;
      const { boardName, layoutId, sizeId, setIds, angle } = resolved.renderBoard;
      openAddToPlaylist(climb, { boardName, layoutId, sizeId, setIds, angle }, anchorPoint);
    },
    [openAddToPlaylist, resolvedRowsByClimbUuid],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: Climb; index: number }) => {
      const resolvedRow = resolvedRowsByClimbUuid.get(item.uuid);
      if (!resolvedRow) return null;

      if (resolvedRow.kind === 'unrenderable') {
        return (
          <UnrenderablePlaylistClimbRow
            climb={item}
            editMode={editMode}
            minimumHeight={editRowHeight}
            onRemove={onRemoveClimb ?? noopRemove}
          />
        );
      }

      if (editMode) {
        return (
          <PlaylistEditClimbRow
            climb={item}
            board={resolvedRow.editBoard}
            rowIndex={index}
            drag={dragControls}
            minimumHeight={editRowHeight}
            onRemove={onRemoveClimb ?? noopRemove}
            onReorder={onReorderClimb ?? noopReorder}
          />
        );
      }

      // The climb you last had up is highlighted, as in the Climbs list (#6671 QA).
      return (
        <ActiveAwareClimbListRow
          climb={toSchemaClimb(item)}
          boardName={resolvedRow.renderBoard.boardName as BoardName}
          layoutId={resolvedRow.renderBoard.layoutId}
          sizeId={resolvedRow.renderBoard.sizeId}
          setIds={resolvedRow.renderBoard.setIds}
          angle={resolvedRow.renderBoard.angle}
          onPress={handleActivate}
          onOpenActions={handleOpenActions}
          onPlayNext={handlePlayNext}
          onOpenPlaylist={handleOpenPlaylist}
          unsupported={resolvedRow.incompatible}
          showProgress
        />
      );
    },
    [
      resolvedRowsByClimbUuid,
      editMode,
      editRowHeight,
      dragControls,
      onRemoveClimb,
      onReorderClimb,
      handleActivate,
      handleOpenActions,
      handlePlayNext,
      handleOpenPlaylist,
    ],
  );

  const onBack = useCallback(() => router.back(), [router]);
  const setHeaderOptions = useCallback(
    (options: Record<string, unknown>) => navigation.setOptions(options),
    [navigation],
  );
  const wrapList = useCallback(
    (list: ReactNode) => (
      <ClimbProgressProvider targets={progressTargets} enabled={!editMode}>
        {list}
      </ClimbProgressProvider>
    ),
    [progressTargets, editMode],
  );
  return (
    <PlaylistDetailPresentation
      {...props}
      renderItem={renderItem}
      isDragging={isDragging}
      listPaddingBottom={bottomChrome.scrollBottomPadding}
      onBack={onBack}
      setHeaderOptions={setHeaderOptions}
      wrapList={wrapList}
      loadingRows={SKELETON_PLACEHOLDERS.map((key) => (
        <ClimbListRowSkeleton key={key} showProgress={!editMode} />
      ))}
      boardBackdrop={
        hero.boardType ? <PlaylistBoardBackdrop boardType={hero.boardType} layoutId={hero.layoutId} /> : undefined
      }
    />
  );
}
function UnrenderablePlaylistClimbRow({
  climb,
  editMode,
  onRemove,
  minimumHeight,
}: {
  climb: Climb;
  editMode: boolean;
  onRemove: (climbUuid: string) => void;
  minimumHeight?: number;
}) {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('playlists');
  const { systemColors, opacity } = useTheme();
  // This row stands among climb rows, so it follows their thumbnail switch: with
  // thumbnails off it has no thumbnail-sized frame and its text starts at the
  // gutter, like theirs.
  const hasThumbnail = useClimbRowField('thumbnail');
  // The cell its neighbours draw (one column here, so 76×96).
  const thumbnailSize = useClimbListThumbnailSize();
  const subtitle = t('detail.unrenderableClimb.subtitle');
  const accessibilityLabel = `${climb.name}. ${subtitle}`;

  const handleRemove = useCallback(() => {
    onRemove(climb.uuid);
  }, [onRemove, climb.uuid]);

  return (
    <View style={styles.unrenderableOuter}>
      <View
        style={[
          styles.unrenderableRow,
          { backgroundColor: systemColors.background },
          minimumHeight === undefined ? null : { minHeight: minimumHeight },
        ]}
        accessible={!editMode}
        accessibilityRole={editMode ? undefined : 'text'}
        accessibilityLabel={editMode ? undefined : accessibilityLabel}
      >
        <View style={[styles.unrenderableContent, { opacity: opacity.disabled }]}>
          {hasThumbnail ? (
            <View
              style={[
                styles.unrenderableThumbnail,
                thumbnailSize,
                { backgroundColor: systemColors.secondaryBackground, borderColor: systemColors.separator },
              ]}
            >
              <Icon name="warning" size={24} color={systemColors.secondaryLabel} />
            </View>
          ) : null}
          <View style={styles.unrenderableText}>
            <Text variant="body" numberOfLines={1} color={systemColors.label} style={styles.unrenderableTitle}>
              {climb.name}
            </Text>
            <Text variant="footnote" numberOfLines={2} color={systemColors.secondaryLabel}>
              {subtitle}
            </Text>
          </View>
        </View>
        {editMode ? (
          <PressableSurface
            onPress={handleRemove}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('editClimbs.removeAria', { name: climb.name })}
            style={({ pressed }) => [styles.unrenderableRemove, pressed && styles.unrenderablePressed]}
          >
            <Icon name="minus.circle" size={24} color={systemColors.error} />
          </PressableSurface>
        ) : null}
      </View>
      <View
        style={[
          styles.unrenderableSeparator,
          {
            marginStart: climbRowSeparatorInset(hasThumbnail, undefined, thumbnailSize.width),
            backgroundColor: systemColors.separator,
          },
        ]}
      />
    </View>
  );
}

// Hoisted stable keys for the first-page skeleton rows — never reorder, so index
// keys are fine and avoid allocating an array on every render. Exported so the
// route-level early-return skeletons share the same count (no drift from this view).
export const SKELETON_PLACEHOLDERS = Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => `skeleton-${index}`);
