// The "On the wall" status capsule — surfaces the climb currently LIT on the
// physical board (when it differs from the user's own queue head, e.g. a teammate
// is driving the wall in a party session). It sits in the centre of the
// top-header islands row (iOS) / a slim band under the app bar (Android).
//
// Leads with the SENDER's avatar (whoever sent the climb to the board), so it
// answers "who lit it + what's lit" at a glance — the core party-session signal a
// lightbulb never carried. The avatar is INERT here (one Pressable opens the
// read-only wall preview; the tap-sender-to-profile affordance lives in that
// preview sheet). Fully-anonymous senders fall back to a neutral person glyph.
//
// Two platform-native skins behind one stateful body (see selectByVariant below):
//   - Liquid Glass (iOS): a NON-glass pill (HIG: no glass-on-glass over the
//     header's progressive blur) with a warm "lit" amber border + tint.
//   - Material 3 (Android): a full-bleed titled status band — a tertiary accent
//     rail + an "On the wall" overline (the lit semantic stated in words and
//     carried by the tertiary colour role) + a bottom divider. No floating pill,
//     no border, no lightbulb (the bottom queue bar already owns that glyph).
// The data, grade derivation, tap handler and the debounced a11y announcement all
// live in the single body so a variant flip never resets the announce dedupe.
// Compact by design — the name truncates, the grade stays.

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { useTheme } from '../../providers/theme-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { spacing, borderRadius } from '../../theme/tokens';
import { withAlpha } from '../../theme/colors';
import { selectByVariant } from '../../theme/variants/select-by-variant';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { boardPresenceClimbToClimb } from '../../lib/board-presence/presence-climb';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { BoardDriverAvatar } from '../board-presence/BoardDriverAvatar';
import { useOpenWallPreview } from './use-open-wall-preview';

const CAPSULE_HEIGHT = 32;
// 20pt reads unambiguously as a face above M3's ~18dp floor while protecting the
// truncating climb name in the tight slot. Fixed — does not scale with Dynamic Type.
const AVATAR_SIZE = 20;
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
};

// memo'd so a ClimbTopChrome re-render (filter/board/search change) doesn't rebuild
// the capsule's hooks while the wall climb is unchanged — the `climb` prop is the
// stable BoardPresenceClimb from useWallClimbIfDistinct (changes only on a wall event).
function WallStatusCapsuleImpl({ climb }: WallStatusCapsuleProps) {
  const { t } = useTranslation('session');
  const { variant, colorScheme, systemColors, brandColors, m3, m3SurfaceContainers } = useTheme();
  const { formatGrade } = useGradeFormat();
  const reduceMotion = useReducedMotion();
  const openWallPreview = useOpenWallPreview();

  const name = climb.name ?? '';
  const formattedGrade = formatGrade(climb.grade ?? '');
  const gradeColor = getGradeColor(climb.grade ?? '') ?? DEFAULT_GRADE_COLOR;
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

  const handlePress = useCallback(() => openWallPreview(boardPresenceClimbToClimb(climb)), [openWallPreview, climb]);

  // Glass: a warm amber tint composited over the neutral surface = the "lit" carrier.
  const glassTintStyle = useMemo(
    () => [StyleSheet.absoluteFill, { backgroundColor: withAlpha(brandColors.warning, 0.14) }],
    [brandColors.warning],
  );

  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });

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
                    size={AVATAR_SIZE}
                    status="none"
                  />
                ) : (
                  <View style={[styles.bandAnon, { backgroundColor: m3SurfaceContainers.highest }]}>
                    <Icon name="profile.fill" size={ANON_GLYPH} color={m3.onSurfaceVariant} />
                  </View>
                )}
              </View>
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
              {gradeNode}
            </View>
          </View>
        </PressableSurface>
      </Animated.View>
    );
  }

  // Liquid Glass (iOS) — the original non-glass amber pill, unchanged.
  return (
    <Animated.View
      // Fades IN on mount and on each wall-climb change (keyed remount). Removal is
      // an instant cut — Reanimated can't reliably intercept an `exiting` whose
      // wrapping parent unmounts in the same commit (the Material under-app-bar row),
      // so we don't promise a fade-out the layout can't deliver.
      key={climbUuid}
      entering={reduceMotion ? undefined : FadeIn.duration(180)}
      style={[
        styles.capsule,
        { backgroundColor: systemColors.secondaryBackground, borderColor: withAlpha(brandColors.warning, 0.35) },
      ]}
    >
      <View pointerEvents="none" style={glassTintStyle} />
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        accessibilityHint={t('mobile.boardPresence.stripA11yHint')}
        style={styles.pressable}
      >
        {/* The sender, leading. Inert + a11y-hidden so the pill reads as one node
            (the profile tap lives in the wall-preview sheet). `userId={null}` is
            deliberate — it only suppresses the avatar's own profile-link tap; the
            face still resolves from `sentByAvatarUrl` (Avatar renders the image off
            `uri`, not `userId`), so this never degrades a known sender's photo. A
            sender with only a userId (no photo, no display name) has nothing
            renderable as a face/monogram, so it correctly takes the person glyph. */}
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {hasSenderIdentity ? (
            <BoardDriverAvatar
              uri={climb.sentByAvatarUrl}
              name={senderName}
              userId={null}
              size={AVATAR_SIZE}
              status="none"
            />
          ) : (
            <Icon name="profile.fill" size={18} color={brandColors.warning} />
          )}
        </View>
        <Text
          variant="footnote"
          color={systemColors.label}
          numberOfLines={1}
          ellipsizeMode="tail"
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={styles.name}
        >
          {name}
        </Text>
        {formattedGrade ? (
          <Text
            variant="footnote"
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={[styles.grade, { color: gradeColor }]}
          >
            {formattedGrade}
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

export const WallStatusCapsule = memo(WallStatusCapsuleImpl);

const styles = StyleSheet.create({
  // --- Liquid Glass (iOS) ---
  capsule: {
    flexShrink: 1,
    maxWidth: '100%',
    height: CAPSULE_HEIGHT,
    borderRadius: CAPSULE_HEIGHT / 2,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  pressable: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    height: '100%',
    paddingLeft: spacing[1],
    paddingRight: spacing[3],
    gap: spacing[2],
  },
  name: {
    flexShrink: 1,
    minWidth: 0,
    fontWeight: '600',
  },
  grade: {
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
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gradePill: {
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing[1],
    justifyContent: 'center',
  },
});
