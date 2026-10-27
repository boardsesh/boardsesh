// The "On the wall" status capsule — surfaces the climb currently LIT on the
// physical board (when it differs from the user's own queue head, e.g. a teammate
// is driving the wall in a party session). It sits in the centre of the
// top-header islands row (iOS) / a slim band under the app bar (Android).
//
// Leads with the sender's avatar so the climb and whoever lit it are visible
// together. The avatar is inert here; the whole pill opens the wall preview,
// which retains the sender profile affordance. Anonymous senders use a person glyph.
//
// Two platform-native skins behind one stateful body (see selectByVariant below):
//   - Liquid Glass (iOS): one regular native-glass pill with a warm "lit" amber
//     tint, laid out like the tab-bar accessory platter: the face, then the name
//     over "V7 · 1.4k sends" (#6902). Older devices and Reduce Transparency
//     retain the opaque pill.
//   - Material 3 (Android): a full-bleed titled status band — a tertiary accent
//     rail + an "On the wall" overline (the lit semantic stated in words and
//     carried by the tertiary colour role) + a bottom divider. No floating pill,
//     no border, no lightbulb (the bottom queue bar already owns that glyph).
// The data, grade derivation, tap handler and the debounced a11y announcement all
// live in the single body so a variant flip never resets the announce dedupe.
// Compact by design — the name truncates.

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { spacing, borderRadius } from '../../theme/tokens';
import { selectByVariant } from '../../theme/variants/select-by-variant';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { boardPresenceClimbToClimb } from '../../lib/board-presence/presence-climb';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { LargeContentViewer } from '../LargeContentViewer';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { BoardDriverAvatar } from '../board-presence/BoardDriverAvatar';
import { useOpenWallPreview } from './use-open-wall-preview';
import { HeaderCapsuleClimbLabel, HeaderStatusCapsule, useHeaderCapsuleCompact } from './HeaderStatusCapsule';
import { useClimbByline } from './use-climb-byline';

// The capsule's face stands in for the platter's board thumbnail, sized to the
// two-line name block beside it. Fixed — does not scale with Dynamic Type.
const CAPSULE_AVATAR_SIZE = 24;
const CAPSULE_ANON_GLYPH = 20;
// 20pt reads unambiguously as a face above M3's ~18dp floor in the Material band.
// Fixed — does not scale with Dynamic Type.
const BAND_AVATAR_SIZE = 20;
const ANON_GLYPH = 12;
// Material status band: a 4dp tertiary accent rail down the leading edge and a
// 56dp two-line body (overline + climb line) — already past the 48dp touch floor.
const BAND_RAIL_WIDTH = 4;
const BAND_MIN_HEIGHT = 56;
// Debounce assistive-tech announcements so a fast party session (rapid wall
// changes) doesn't spam the speech queue.
const ANNOUNCE_DEBOUNCE_MS = 600;

type WallStatusCapsuleProps = {
  /** The wall's lit climb (already resolved as distinct from the queue head). */
  climb: BoardPresenceClimb;
  /** The board in scope, so the grade reads on its scale. The wall payload names no board. */
  boardName?: string | null;
};

// memo'd so a ClimbTopChrome re-render (filter/board/search change) doesn't rebuild
// the capsule's hooks while the wall climb is unchanged — the `climb` prop is the
// stable BoardPresenceClimb from useWallClimbIfDistinct (changes only on a wall event).
function WallStatusCapsuleImpl({ climb, boardName }: WallStatusCapsuleProps) {
  const { t } = useTranslation('session');
  const { variant, colorScheme, brandColors, m3, m3SurfaceContainers } = useTheme();
  const { resolveGrade } = useDisplayGrade();
  const reduceMotion = useReducedMotion();
  const openWallPreview = useOpenWallPreview();
  const compact = useHeaderCapsuleCompact();
  const { boardConfig } = useDrawerHost();

  const name = climb.name ?? '';
  // BoardPresenceClimb carries no Boardsesh grade today, so `resolveGrade` falls
  // back to the legacy label + colour — the capsule swaps to the Boardsesh grade
  // once the backend stamps presence climbs.
  const resolvedGrade = resolveGrade({ difficulty: climb.grade ?? '' }, boardName);
  const formattedGrade = climb.grade ? resolvedGrade.label : null;
  const gradeColor = resolvedGrade.color;
  const senderName = climb.sentByDisplayName?.trim() || null;
  const hasSenderIdentity = climb.sentByAvatarUrl != null || senderName != null;

  const a11yLabel = senderName
    ? t('mobile.boardPresence.stripA11yLabelWithSender', { name, grade: formattedGrade ?? '', sender: senderName })
    : t('mobile.boardPresence.stripA11yLabel', { name, grade: formattedGrade ?? '' });

  // Announce peer-driven changes the user didn't initiate (debounced + de-duped on
  // the climb's uuid so a re-render doesn't re-announce the same climb). Done
  // explicitly rather than via accessibilityLiveRegion, because the capsule remounts
  // on each climb change (keyed Animated.View) — a fresh node has no "content
  // change" for a live region to catch.
  const announceLabel = senderName
    ? t('mobile.boardPresence.stripAnnounceWithSender', { name, grade: formattedGrade ?? '', sender: senderName })
    : t('mobile.boardPresence.stripAnnounce', { name, grade: formattedGrade ?? '' });
  const climbUuid = climb.climbUuid;
  // De-dupe on the announced TEXT, not the uuid: a re-render with an unchanged label
  // shouldn't re-announce, but a locale switch (same climb, new label) should.
  const lastAnnouncedRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastAnnouncedRef.current === announceLabel) return;
    const handle = setTimeout(() => {
      lastAnnouncedRef.current = announceLabel;
      AccessibilityInfo.announceForAccessibility(announceLabel);
    }, ANNOUNCE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [announceLabel]);

  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  const climbForStats = useMemo(() => boardPresenceClimbToClimb(climb), [climb]);
  // The platter's byline: the plain grade, then the sends (or the rating). An
  // older reporter sends no angle, and the converted climb's 0° would read some
  // other angle's sends, so that shows the grade alone. The Material band has
  // no byline, so it skips the stats read.
  const byline = useClimbByline(climbForStats, boardConfig, formattedGrade, {
    statsEnabled: !isMaterial && climb.angle != null,
  });

  const handlePress = useCallback(() => openWallPreview(climbForStats), [openWallPreview, climbForStats]);

  if (isMaterial) {
    // The grade sits on the app-bar surface (the band body is transparent). In the
    // light scheme that surface is near-white, where bright hues (e.g. V0 #FFD400)
    // fail 4.5:1 — so wrap the grade in a neutral tonal pill there. Dark scheme keeps
    // bare text (already legible on the dark surface).
    const gradeNode = formattedGrade ? (
      colorScheme === 'light' ? (
        <View style={[styles.gradePill, { backgroundColor: m3SurfaceContainers.highest }]}>
          <Text
            variant="subheadline"
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={[styles.grade, { color: gradeColor }]}
          >
            {formattedGrade}
          </Text>
        </View>
      ) : (
        <Text
          variant="subheadline"
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={[styles.grade, { color: gradeColor }]}
        >
          {formattedGrade}
        </Text>
      )
    ) : null;

    return (
      <Animated.View
        key={climbUuid}
        entering={reduceMotion ? undefined : FadeIn.duration(180)}
        style={[styles.bandOuter, { borderBottomColor: m3.outlineVariant }]}
      >
        <PressableSurface
          onPress={handlePress}
          // Android rides its native ripple; the iOS Material opt-in keeps it static.
          feedback="none"
          // Neutral M3 state layer — the warmth lives in the rail + overline.
          rippleColor={m3.onSurfaceVariant}
          accessibilityRole="button"
          accessibilityLabel={a11yLabel}
          accessibilityHint={t('mobile.boardPresence.stripA11yHint')}
          style={styles.bandPressable}
        >
          {/* The "lit" accent: a tertiary rail down the leading edge. */}
          <View pointerEvents="none" style={[styles.bandRail, { backgroundColor: m3.tertiary }]} />
          <View style={styles.bandContent}>
            <Text
              variant="caption1"
              numberOfLines={1}
              // Truncate the trailing sender, never the protected "On the wall" prefix.
              ellipsizeMode="tail"
              maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
              style={[styles.bandOverline, { color: m3.tertiary }]}
            >
              {senderName
                ? t('mobile.boardPresence.stripOverlineWithSender', { sender: senderName })
                : t('mobile.boardPresence.stripOverline')}
            </Text>
            <View style={styles.bandMainRow}>
              {/* Inert + a11y-hidden so the band reads as one node (the profile tap
                  lives in the wall-preview sheet). `userId={null}` only suppresses the
                  avatar's own profile-link tap; the face still resolves from `uri`. */}
              <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                {hasSenderIdentity ? (
                  <BoardDriverAvatar
                    uri={climb.sentByAvatarUrl}
                    name={senderName}
                    userId={null}
                    size={BAND_AVATAR_SIZE}
                    status="none"
                  />
                ) : (
                  <View style={[styles.bandAnon, { backgroundColor: m3SurfaceContainers.highest }]}>
                    <Icon maxFontSizeMultiplier={1} name="profile.fill" size={ANON_GLYPH} color={m3.onSurfaceVariant} />
                  </View>
                )}
              </View>
              <LargeContentViewer title={a11yLabel} onActivate={handlePress} style={{ flex: 1 }}>
                <Text
                  variant="subheadline"
                  color={m3.onSurface}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
                  style={styles.bandName}
                >
                  {name}
                </Text>
              </LargeContentViewer>
              {gradeNode}
            </View>
          </View>
        </PressableSurface>
      </Animated.View>
    );
  }

  return (
    <HeaderStatusCapsule
      tintColor={brandColors.warning}
      entryKey={climbUuid}
      onPress={handlePress}
      accessibilityLabel={a11yLabel}
      accessibilityHint={t('mobile.boardPresence.stripA11yHint')}
      compact={compact}
    >
      {/* One tap target and one spoken label; profile navigation lives in the preview. */}
      <HeaderCapsuleClimbLabel
        avatar={
          hasSenderIdentity ? (
            <BoardDriverAvatar
              uri={climb.sentByAvatarUrl}
              name={senderName}
              userId={null}
              size={CAPSULE_AVATAR_SIZE}
              status="none"
            />
          ) : (
            <Icon maxFontSizeMultiplier={1} name="profile.fill" size={CAPSULE_ANON_GLYPH} color={brandColors.warning} />
          )
        }
        name={name}
        byline={byline}
        compact={compact}
        largeContentTitle={a11yLabel}
        onActivate={handlePress}
      />
    </HeaderStatusCapsule>
  );
}

export const WallStatusCapsule = memo(WallStatusCapsuleImpl);

const styles = StyleSheet.create({
  grade: {
    flexShrink: 0,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  // --- Material 3 status band (Android) ---
  bandOuter: {
    width: '100%',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bandPressable: {
    minHeight: BAND_MIN_HEIGHT,
    justifyContent: 'center',
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[4],
  },
  bandRail: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: BAND_RAIL_WIDTH,
  },
  bandContent: {
    gap: 2,
  },
  bandOverline: {
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  bandMainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  bandName: {
    flex: 1,
    minWidth: 0,
    fontWeight: '500',
  },
  bandAnon: {
    width: BAND_AVATAR_SIZE,
    height: BAND_AVATAR_SIZE,
    borderRadius: BAND_AVATAR_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gradePill: {
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing[1],
    justifyContent: 'center',
  },
});
