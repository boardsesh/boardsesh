import { WallStatusCapsuleView, type WallStatusCapsuleProps } from './WallStatusCapsuleView';
// The "On the wall" status capsule — surfaces the climb currently LIT on the
// physical board, whoever lit it and whatever the queue shows, while presence
// trusts it (`resolveClimbsHeaderCapsule`). It sits in the centre of the
// top-header islands row (iOS) or in the Climbs app bar's title slot (Material).
// The climber can hide it until another climb goes up: a left swipe or the
// screen-reader action "Hide". Neither skin has a ×.
//
// Leads with the sender's avatar so the climb and whoever lit it are visible
// together. The avatar is inert here; the whole pill opens the wall preview,
// which retains the sender profile affordance.
//
// Two platform-native skins behind one stateful body (see selectByVariant below):
//   - Liquid Glass (iOS): one regular native-glass pill with a warm "lit" amber
//     tint: the name over the grade and one fact (#7281). Someone else's climb
//     says who lit it (their face where the capsule has room, their name after
//     the grade); your own climb says its sends; a climb lit with no live link
//     says how long ago ("V6 · 20m ago"), so it never reads as live. Older
//     devices and Reduce Transparency retain the opaque pill.
//   - Material 3 (the Android Climbs bar): the same content in M3 dress, plus
//     the climb's board art. A 48dp full-radius pill in the amber
//     `live` fill (the "lit" amber, as the iOS capsule's warm tint) that
//     fills the app bar's title slot (up to 280dp). It leads with the MiniPlayer's
//     board-art thumbnail (from a 130dp pill), then the sender's face where glass
//     would show it (from a 180dp pill beside the thumbnail), then the name in
//     titleSmall over the same "grade · one fact" byline as glass, in
//     labelMedium, all in `onLive`.
// The data, grade derivation, tap handler and the debounced a11y announcement all
// live in the single body so a variant flip never resets the announce dedupe.
// Compact by design — the name truncates.

import { memo, useCallback, useMemo } from 'react';
import { useAuroraPresenceGrades } from '../../hooks/use-aurora-presence-grades';
import { presentAuroraClimb, withAuroraActionOrientation } from '@boardsesh/board-presence-react/presentation';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { useViewerUserId } from '../../hooks/use-viewer-user-id';
import { boardPresenceClimbToClimb } from '../../lib/board-presence/presence-climb';
import { useAuth } from '../../providers/auth-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { BoardDriverAvatar } from '../board-presence/BoardDriverAvatar';
import { AccessoryClimbThumbnail } from './AccessoryClimbThumbnail';
import { useClimbStatsDetail } from './use-climb-byline';
import { useOpenWallPreview } from './use-open-wall-preview';

function WallStatusCapsuleImpl(props: WallStatusCapsuleProps) {
  const { climb, boardName, presentation } = props;
  const { resolveGrade } = useDisplayGrade();
  const openWallPreview = useOpenWallPreview();
  const { isAuthenticated } = useAuth();
  const viewerUserId = useViewerUserId();
  const { boardConfig, boardPanelProps } = useDrawerHost();
  const { boardId, boardUuid } = useBoardPresenceControls();
  const canPreview =
    climb.source !== 'aurora' ||
    (boardConfig !== null && props.boardId != null && props.boardId === boardId && boardConfig.boardName === boardName);
  const history = presentation?.kind === 'history';
  const senderName = climb.sentByDisplayName?.trim() || null;
  const senderIsYou = climb.sentByUserId != null && climb.sentByUserId === viewerUserId;
  const senderPending = isAuthenticated && viewerUserId == null && climb.sentByUserId != null;
  const namedOther = senderName != null && !senderIsYou && !senderPending;
  const gradeClimbs = useMemo(() => [climb], [climb]);
  const auroraGrades = useAuroraPresenceGrades(gradeClimbs, canPreview ? boardConfig : null, {
    boardId: canPreview ? boardId : null,
    boardUuid,
  });
  const gradeFields = climb.source === 'aurora' ? auroraGrades.get(climb.climbUuid) : undefined;
  const resolvedGrade = resolveGrade(gradeFields ?? { difficulty: climb.grade ?? '' }, boardName);
  const previewClimb = useMemo(
    () =>
      !canPreview
        ? null
        : {
            ...boardPresenceClimbToClimb(
              boardConfig ? presentAuroraClimb(climb, boardConfig.angle, gradeFields?.difficulty ?? null) : climb,
              boardConfig?.angle,
            ),
            ...(gradeFields ? { ...gradeFields, difficulty: gradeFields.difficulty ?? '' } : {}),
          },
    [climb, boardConfig, gradeFields, canPreview],
  );
  const statsDetail = useClimbStatsDetail(previewClimb, boardConfig, {
    statsEnabled:
      canPreview && !history && !namedOther && !senderPending && (climb.angle != null || climb.source === 'aurora'),
  });
  const onPress = useCallback(() => {
    if (!previewClimb || !canPreview) return;
    openWallPreview(withAuroraActionOrientation(previewClimb, climb, boardPanelProps?.getClimbMirror));
  }, [openWallPreview, previewClimb, canPreview, climb, boardPanelProps]);
  return (
    <WallStatusCapsuleView
      {...props}
      formattedGrade={
        climb.grade || gradeFields?.difficulty || gradeFields?.boardseshDifficulty != null ? resolvedGrade.label : null
      }
      senderIsYou={senderIsYou}
      senderPending={senderPending}
      statsDetail={statsDetail}
      onPress={onPress}
      previewEnabled={canPreview}
      thumbnail={
        climb.frames && boardConfig && canPreview ? (
          <AccessoryClimbThumbnail
            climb={{ frames: climb.frames, mirrored: climb.mirrored }}
            boardConfig={boardConfig}
          />
        ) : null
      }
      avatar={<BoardDriverAvatar uri={climb.sentByAvatarUrl} name={senderName} userId={null} size={24} status="none" />}
    />
  );
}
export const WallStatusCapsule = memo(WallStatusCapsuleImpl);
