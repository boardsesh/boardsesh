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
//     `tertiaryContainer` (the "lit" tone, as the iOS capsule's warm tint) that
//     fills the app bar's title slot (up to 280dp). It leads with the MiniPlayer's
//     board-art thumbnail (from a 130dp pill), then the sender's face where glass
//     would show it (from a 180dp pill beside the thumbnail), then the name in
//     titleSmall over the same "grade · one fact" byline as glass, in
//     labelMedium, all in `onTertiaryContainer`.
// The data, grade derivation, tap handler and the debounced a11y announcement all
// live in the single body so a variant flip never resets the announce dedupe.
// Compact by design — the name truncates.

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { spacing, borderRadius } from '../../theme/tokens';
import { selectByVariant } from '../../theme/variants/select-by-variant';
import { boardPresenceClimbToClimb } from '../../lib/board-presence/presence-climb';
import { PressableSurface } from '../PressableSurface';
import { BoardDriverAvatar } from '../board-presence/BoardDriverAvatar';
import { useOpenWallPreview } from './use-open-wall-preview';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useViewerUserId } from '../../hooks/use-viewer-user-id';
import { useAuth } from '../../providers/auth-provider';
import { useClimbStatsDetail } from './use-climb-byline';
import { CENTER_CONTENT_MAX_WIDTH } from '../chrome/native-title-bound';
import { AccessoryClimbThumbnail } from './AccessoryClimbThumbnail';
import {
  HeaderCapsuleClimbLabel,
  HeaderStatusCapsule,
  headerCapsuleCompact,
  headerCapsuleFaceFits,
  useHeaderCapsuleCompact,
  useHeaderCapsuleFaceFits,
  type HeaderCapsuleByline,
} from './HeaderStatusCapsule';
import { WallCapsuleSwipe } from './WallCapsuleSwipe';
import { useWallCapsuleDismiss } from './use-wall-capsule-dismiss';

// The capsule's face stands in for the platter's board thumbnail, sized to the
// two-line name block beside it. Fixed — does not scale with Dynamic Type.
const CAPSULE_AVATAR_SIZE = 24;
// Material pill: its own 48dp touch target. The leading thumbnail is the
// MiniPlayer's 40dp slot (a portrait board fits about 32×40, radius 10).
const APP_BAR_PILL_HEIGHT = 48;
// Thumbnail and face together cost the name 72dp, so the face joins the
// thumbnail only from a 180dp pill (a 360dp phone's bar leaves about 200dp);
// a narrower pill keeps the thumbnail and its byline still names the sender.
const MATERIAL_FACE_BESIDE_THUMBNAIL_MIN_WIDTH = 180;
// Debounce assistive-tech announcements so a fast party session (rapid wall
// changes) doesn't spam the speech queue.
const ANNOUNCE_DEBOUNCE_MS = 600;

type WallStatusCapsuleProps = {
  /** The wall's lit climb (already resolved as distinct from the queue head). */
  climb: BoardPresenceClimb;
  /** The board in scope, so the grade reads on its scale. The wall payload names no board. */
  boardName?: string | null;
  /** History: `ageLabel` ("20m") is spoken, `ageByline` ("20m ago") shows under the name. */
  presentation?: { kind: 'live' } | { kind: 'history'; ageLabel: string; ageByline: string };
  occurrenceKey?: string;
  onDismiss?: (occurrenceKey: string) => void;
};

// memo'd so a ClimbTopChrome re-render (filter/board/search change) doesn't rebuild
// the capsule's hooks while the wall climb is unchanged — the `climb` prop is the
// stable BoardPresenceClimb from the wall-climb context (changes only on a wall event).
function WallStatusCapsuleImpl({ climb, boardName, presentation, occurrenceKey, onDismiss }: WallStatusCapsuleProps) {
  const { t } = useTranslation('session');
  const { variant, brandColors, m3 } = useTheme();
  const { resolveGrade } = useDisplayGrade();
  const reduceMotion = useReducedMotion();
  const openWallPreview = useOpenWallPreview();
  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  // UIKit hands the glass capsule its title bound; the Material pill fills its
  // slot, so its own measured width is that bound, under the same rules. Until
  // it has measured, no leading thumbnail, so a narrow slot never flashes one.
  const [materialWidth, setMaterialWidth] = useState<number | undefined>(undefined);
  const handleMaterialLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setMaterialWidth((previous) => (previous === width ? previous : width));
  }, []);
  const nativeLeadingFits = useHeaderCapsuleFaceFits();
  const nativeNarrowTitle = useHeaderCapsuleCompact();
  const leadingFits = isMaterial
    ? materialWidth !== undefined && headerCapsuleFaceFits(materialWidth)
    : nativeLeadingFits;
  const narrowTitle = isMaterial ? headerCapsuleCompact(materialWidth) : nativeNarrowTitle;
  const { isAuthenticated } = useAuth();
  const viewerUserId = useViewerUserId();
  const { boardConfig } = useDrawerHost();
  const history = presentation?.kind === 'history' ? presentation : null;
  const swipe = useWallCapsuleDismiss({
    occurrenceKey: occurrenceKey ?? `${climb.seq}:${climb.sentAt}:${climb.climbUuid}`,
    onDismiss,
    reduceMotion,
  });

  const name = climb.name ?? '';
  // BoardPresenceClimb carries no Boardsesh grade today, so `resolveGrade` falls
  // back to the legacy label + colour — the capsule swaps to the Boardsesh grade
  // once the backend stamps presence climbs.
  const resolvedGrade = resolveGrade({ difficulty: climb.grade ?? '' }, boardName);
  const formattedGrade = climb.grade ? resolvedGrade.label : null;
  const senderName = climb.sentByDisplayName?.trim() || null;
  const hasSenderIdentity = climb.sentByAvatarUrl != null || senderName != null;
  // Someone else lit it, and has a name: their face and name say who. Your own
  // climb, or an unnamed sender's, says its sends instead. While a signed-in
  // climber's id is still loading, nobody can say whose it is: grade alone, so
  // your own climb never flashes your face and name.
  const senderIsYou = climb.sentByUserId != null && climb.sentByUserId === viewerUserId;
  const senderPending = isAuthenticated && viewerUserId == null && climb.sentByUserId != null;
  const namedOther = senderName != null && !senderIsYou && !senderPending;
  // Material leads with the climb's board art, on the board this list (and
  // presence) is scoped to: the presence payload carries the frames and mirror
  // flag, and the drawer host the board.
  const thumbnailFrames = climb.frames ?? '';
  const showThumbnail = isMaterial && leadingFits && thumbnailFrames !== '' && boardConfig != null;
  // The face follows glass's rule; beside a thumbnail it needs the wider pill.
  const faceFits =
    isMaterial && showThumbnail
      ? materialWidth !== undefined && materialWidth >= MATERIAL_FACE_BESIDE_THUMBNAIL_MIN_WIDTH
      : leadingFits;
  const showFace = namedOther && hasSenderIdentity && faceFits;

  const a11yLabel = history
    ? senderName
      ? t('mobile.boardPresence.stripHistoryA11yLabelWithSender', {
          name,
          grade: formattedGrade ?? '',
          age: history.ageLabel,
          sender: senderName,
        })
      : t('mobile.boardPresence.stripHistoryA11yLabel', { name, grade: formattedGrade ?? '', age: history.ageLabel })
    : senderName
      ? t('mobile.boardPresence.stripA11yLabelWithSender', { name, grade: formattedGrade ?? '', sender: senderName })
      : t('mobile.boardPresence.stripA11yLabel', { name, grade: formattedGrade ?? '' });

  // Announce peer-driven changes the user didn't initiate (debounced + de-duped on
  // the climb's uuid so a re-render doesn't re-announce the same climb). Done
  // explicitly rather than via accessibilityLiveRegion, because the capsule remounts
  // on each climb change (keyed Animated.View) — a fresh node has no "content
  // change" for a live region to catch.
  const announceLabel = history
    ? null
    : senderName
      ? t('mobile.boardPresence.stripAnnounceWithSender', { name, grade: formattedGrade ?? '', sender: senderName })
      : t('mobile.boardPresence.stripAnnounce', { name, grade: formattedGrade ?? '' });
  const climbUuid = climb.climbUuid;
  // De-dupe on the announced TEXT, not the uuid: a re-render with an unchanged label
  // shouldn't re-announce, but a locale switch (same climb, new label) should.
  const lastAnnouncedRef = useRef<string | null>(null);
  useEffect(() => {
    // History is read on focus; its minute-by-minute age is never a live announcement.
    if (announceLabel === null) return undefined;
    if (lastAnnouncedRef.current === announceLabel) return;
    const handle = setTimeout(() => {
      lastAnnouncedRef.current = announceLabel;
      AccessibilityInfo.announceForAccessibility(announceLabel);
    }, ANNOUNCE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [announceLabel]);

  const previewClimb = useMemo(() => boardPresenceClimbToClimb(climb), [climb]);
  // The sends only where the byline says them: a live climb that is not someone
  // else's. An older reporter sends no angle, and the converted climb's 0° would
  // read some other angle's sends, so that shows the grade alone.
  const statsDetail = useClimbStatsDetail(previewClimb, boardConfig, {
    statsEnabled: !history && !namedOther && !senderPending && climb.angle != null,
  });
  // A climb with no name shows its grade as the name, so line 2 drops it. The age
  // stays whole unless the title is too narrow for it (a 320pt Display Zoom bar).
  const bylineGrade = name ? formattedGrade : null;
  const byline: HeaderCapsuleByline = history
    ? { grade: bylineGrade, detail: history.ageByline, fixed: !narrowTitle }
    : { grade: bylineGrade, detail: namedOther ? senderName : statsDetail };

  const { consumePanned, dismiss } = swipe;
  const handlePress = useCallback(() => {
    if (consumePanned()) return;
    openWallPreview(previewClimb);
  }, [consumePanned, openWallPreview, previewClimb]);
  // "Hide": the screen-reader action's name.
  const hideLabel = t('mobile.boardPresence.stripDismiss');
  const accessibilityActions = onDismiss ? [{ name: 'dismiss', label: hideLabel }] : undefined;
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'dismiss') dismiss();
    },
    [dismiss],
  );
  const accessibilityHint = onDismiss
    ? t('mobile.boardPresence.stripDismissHint')
    : t('mobile.boardPresence.stripA11yHint');
  let capsule: ReactNode;
  // One tap target and one spoken label; profile navigation lives in the preview.
  const climbLabelAvatar = showFace ? (
    <BoardDriverAvatar
      uri={climb.sentByAvatarUrl}
      name={senderName}
      userId={null}
      size={CAPSULE_AVATAR_SIZE}
      status="none"
    />
  ) : null;

  if (isMaterial) {
    capsule = (
      <Animated.View
        key={climbUuid}
        entering={reduceMotion ? undefined : FadeIn.duration(180)}
        onLayout={handleMaterialLayout}
        style={[styles.appBarPill, { backgroundColor: m3.tertiaryContainer }]}
      >
        <PressableSurface
          onPress={handlePress}
          // Android rides its native ripple, clipped by the pill's radius: the
          // M3 state layer is the container's own ink.
          feedback="none"
          rippleColor={m3.onTertiaryContainer}
          accessibilityRole="button"
          accessibilityLabel={a11yLabel}
          accessibilityHint={accessibilityHint}
          accessibilityActions={accessibilityActions}
          onAccessibilityAction={handleAccessibilityAction}
          style={[
            styles.appBarRow,
            showThumbnail ? styles.appBarRowWithThumbnail : showFace ? styles.appBarRowWithFace : null,
          ]}
        >
          <HeaderCapsuleClimbLabel
            skin="material"
            avatar={
              showThumbnail || showFace ? (
                <View style={styles.appBarLeading}>
                  {showThumbnail ? (
                    // Through the shared render scheduler (BoardImageNative ->
                    // useNativeClimbRender), never a play surface.
                    <AccessoryClimbThumbnail
                      climb={{ frames: thumbnailFrames, mirrored: climb.mirrored }}
                      boardConfig={boardConfig}
                    />
                  ) : null}
                  {climbLabelAvatar}
                </View>
              ) : null
            }
            // A reporter that sent no name still shows something: the grade.
            name={name || formattedGrade || ''}
            byline={byline}
            compact={!showThumbnail && !showFace}
            largeContentTitle={a11yLabel}
            onActivate={handlePress}
          />
        </PressableSurface>
      </Animated.View>
    );
  } else {
    capsule = (
      <HeaderStatusCapsule
        tintColor={brandColors.warning}
        entryKey={climbUuid}
        onPress={handlePress}
        accessibilityLabel={a11yLabel}
        accessibilityHint={accessibilityHint}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={handleAccessibilityAction}
        compact={!showFace}
      >
        <HeaderCapsuleClimbLabel
          avatar={climbLabelAvatar}
          // A reporter that sent no name still shows something: the grade.
          name={name || formattedGrade || ''}
          byline={byline}
          compact={!showFace}
          largeContentTitle={a11yLabel}
          onActivate={handlePress}
        />
      </HeaderStatusCapsule>
    );
  }

  if (!onDismiss) return capsule;
  return (
    <WallCapsuleSwipe swipe={swipe} style={isMaterial ? styles.appBarWidth : null}>
      {capsule}
    </WallCapsuleSwipe>
  );
}

export const WallStatusCapsule = memo(WallStatusCapsuleImpl);

const styles = StyleSheet.create({
  // --- Material 3 app-bar pill (the Android Climbs bar) ---
  // Fills the title slot, never past the glass capsule's 280 cap.
  appBarWidth: {
    width: '100%',
    maxWidth: CENTER_CONTENT_MAX_WIDTH,
  },
  appBarPill: {
    width: '100%',
    maxWidth: CENTER_CONTENT_MAX_WIDTH,
    height: APP_BAR_PILL_HEIGHT,
    borderRadius: borderRadius.full,
    overflow: 'hidden',
  },
  appBarRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
  },
  // The 40dp thumbnail slot already insets the art from the pill's curve.
  appBarRowWithThumbnail: {
    paddingStart: spacing[1],
  },
  // A round face sits in the curve like the glass capsule's.
  appBarRowWithFace: {
    paddingStart: spacing[3],
  },
  appBarLeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
});
